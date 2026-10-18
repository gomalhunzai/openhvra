// Glacial lake outburst flood (GLOF) screening by following the water.
//
// For each glacial lake the outflow path is traced downstream:
//   1. from the lake outlet along OpenStreetMap waterways (drawn in the
//      direction of flow), joining at confluences and bridging small gaps;
//   2. where no waterway leaves the lake, or the mapped network ends, by
//      steepest descent on a regional elevation model (with a small search
//      to step out of noise pits);
//   3. or along a path drawn by the user, which then replaces the trace.
// Only lakes whose path passes through the analysed area count. Buildings are
// scored by how far they sit above the path compared with a flood height that
// falls with distance downstream (default 20 m at the lake to 5 m at 30 km).

import { lonLatArea, makeProjection, GridIndex, nearestOnSeg } from './spatial.js';
import { loadDEM } from './risk.js';

export const GLOF_DEFAULTS = { h0: 20, h30: 5, corridor: 600, maxPathKm: 80 };
const scale = (v, lo, hi) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
const key = (c) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;

// ---- Parsing Overpass output -------------------------------------------------------------------

function wayCoords(el) {
  return (el.geometry ?? []).filter(Boolean).map((p) => [p.lon, p.lat]);
}
function memberLines(el) {
  return (el.members ?? []).filter((m) => m.geometry && m.role !== 'inner').map((m) => m.geometry.filter(Boolean).map((p) => [p.lon, p.lat]));
}
const closed = (c) => c.length >= 4 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];

export function parseGlofElements(elements) {
  const glaciers = [];
  const lakes = [];
  const waterways = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    if (t.natural === 'glacier') {
      if (el.type === 'way') {
        const c = wayCoords(el);
        if (c.length >= 2) glaciers.push({ type: 'Feature', properties: { name: t.name ?? '', source: 'OpenStreetMap' }, geometry: closed(c) ? { type: 'Polygon', coordinates: [c] } : { type: 'LineString', coordinates: c } });
      } else if (el.type === 'relation') {
        const lines = memberLines(el);
        if (lines.length) glaciers.push({ type: 'Feature', properties: { name: t.name ?? '', source: 'OpenStreetMap' }, geometry: { type: 'MultiLineString', coordinates: lines } });
      }
    } else if (t.natural === 'water') {
      let outline = [];
      let area = 0;
      let lon;
      let lat;
      if (el.type === 'way') {
        const c = wayCoords(el);
        if (c.length < 4) continue;
        outline = [c];
        area = lonLatArea(c);
        const n = closed(c) ? c.length - 1 : c.length;
        lon = c.slice(0, n).reduce((a, p) => a + p[0], 0) / n;
        lat = c.slice(0, n).reduce((a, p) => a + p[1], 0) / n;
      } else if (el.bounds) {
        outline = memberLines(el);
        const { minlat, minlon, maxlat, maxlon } = el.bounds;
        lon = (minlon + maxlon) / 2;
        lat = (minlat + maxlat) / 2;
        area = 0.6 * lonLatArea([[minlon, minlat], [maxlon, minlat], [maxlon, maxlat], [minlon, maxlat]]);
      } else continue;
      lakes.push({ id: `osm:${el.type}/${el.id}`, name: t.name ?? '', lon, lat, area, outline, source: 'OpenStreetMap' });
    } else if (t.waterway && el.type === 'way') {
      const c = wayCoords(el);
      if (c.length >= 2) waterways.push({ coords: c, type: t.waterway, name: t.name ?? '' });
    }
  }
  return { glaciers, lakes, waterways };
}

// ---- Waterway network ----------------------------------------------------------------------------

const RANK = { river: 3, canal: 2, stream: 1 };

export function buildNetwork(waterways) {
  if (!waterways.length) return null;
  const [lon0, lat0] = waterways[0].coords[0];
  const proj = makeProjection(lon0, lat0);
  const nodes = new Map();
  const vIndex = new GridIndex(200);
  waterways.forEach((w, wi) => {
    w.xy = w.coords.map(([lon, lat]) => proj.toXY(lon, lat));
    w.coords.forEach((c, i) => {
      const k = key(c);
      if (!nodes.has(k)) nodes.set(k, []);
      nodes.get(k).push({ wi, i });
      const [x, y] = w.xy[i];
      vIndex.insert({ wi, i, x, y }, x, y, x, y);
    });
  });
  return { ways: waterways, nodes, vIndex, proj };
}

// Waterways leaving the lake: they start near it and end farther away.
function networkOutlet(lake, net) {
  const [cx, cy] = net.proj.toXY(lake.lon, lake.lat);
  const R = Math.sqrt(lake.area / Math.PI) + 150;
  let best = null;
  net.vIndex.query(cx - R, cy - R, cx + R, cy + R, (v) => {
    const w = net.ways[v.wi];
    if (v.i !== 0) return;
    const d0 = Math.hypot(v.x - cx, v.y - cy);
    if (d0 > R) return;
    const [ex, ey] = w.xy[w.xy.length - 1];
    const dEnd = Math.hypot(ex - cx, ey - cy);
    if (dEnd <= d0) return; // flows into the lake, not out of it
    if (!best || dEnd > best.dEnd) best = { wi: v.wi, i: 0, dEnd };
  });
  return best;
}

function followNetwork(net, start, maxM) {
  const path = [];
  const visited = new Set();
  let { wi, i } = start;
  let length = 0;
  for (let hops = 0; hops < 5000; hops++) {
    const w = net.ways[wi];
    visited.add(wi);
    for (let j = i; j < w.coords.length; j++) {
      if (path.length) {
        const [px, py] = net.proj.toXY(...path[path.length - 1]);
        length += Math.hypot(w.xy[j][0] - px, w.xy[j][1] - py);
      }
      path.push(w.coords[j]);
      if (length > maxM) return { path, length, ended: false };
    }
    const end = w.coords[w.coords.length - 1];
    let next = (net.nodes.get(key(end)) ?? []).filter((o) => !visited.has(o.wi) && o.i < net.ways[o.wi].coords.length - 1);
    if (!next.length) {
      // Bridge small mapping gaps (culverts, unconnected ends) up to 60 m.
      const [ex, ey] = w.xy[w.xy.length - 1];
      let snap = null;
      net.vIndex.query(ex - 60, ey - 60, ex + 60, ey + 60, (v) => {
        if (visited.has(v.wi) || v.i >= net.ways[v.wi].coords.length - 1) return;
        const d = Math.hypot(v.x - ex, v.y - ey);
        if (d <= 60 && (!snap || d < snap.d)) snap = { ...v, d };
      });
      if (snap) next = [snap];
    }
    if (!next.length) return { path, length, ended: true };
    next.sort((a, b) => (RANK[net.ways[b.wi].type] ?? 0) - (RANK[net.ways[a.wi].type] ?? 0));
    ({ wi, i } = next[0]);
  }
  return { path, length, ended: true };
}

// ---- Terrain tracing ---------------------------------------------------------------------------------

function traceTerrain(dem, lon, lat, maxM) {
  let [px, py] = dem.pixel(lon, lat).map(Math.round);
  let z = dem._at(px, py);
  if (!Number.isFinite(z)) return { path: [], length: 0 };
  const path = [dem.lonLat(px, py)];
  const seen = new Set([`${px},${py}`]);
  const mpp = dem.metresPerPixel(lat);
  let length = 0;
  for (let step = 0; step < 20000 && length < maxM; step++) {
    let best = null;
    // Steepest descent among neighbours; widen the ring to step out of pits.
    for (let r = 1; r <= 8 && !best; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const v = dem._at(px + dx, py + dy);
          if (!(v < z) || seen.has(`${px + dx},${py + dy}`)) continue;
          const slope = (z - v) / Math.hypot(dx, dy);
          if (!best || slope > best.slope) best = { dx, dy, v, slope };
        }
      }
    }
    if (!best) break;
    px += best.dx;
    py += best.dy;
    z = best.v;
    seen.add(`${px},${py}`);
    length += Math.hypot(best.dx, best.dy) * mpp;
    path.push(dem.lonLat(px, py));
  }
  return { path, length };
}

// Lowest point on the lake shore (outline vertices, or a ring for point lakes).
function terrainOutlet(lake, dem) {
  const pts = lake.outline?.length
    ? lake.outline.flat()
    : (() => {
      const r = Math.sqrt(lake.area / Math.PI) + 40;
      const p = makeProjection(lake.lon, lake.lat);
      return Array.from({ length: 24 }, (_, i) => p.toLonLat(r * Math.cos((i / 24) * 2 * Math.PI), r * Math.sin((i / 24) * 2 * Math.PI)));
    })();
  let best = null;
  for (const c of pts) {
    const v = dem.elev(c[0], c[1]);
    if (Number.isFinite(v) && (!best || v < best.v)) best = { c, v };
  }
  return best?.c ?? [lake.lon, lake.lat];
}

function pathLength(path) {
  let s = 0;
  for (let i = 1; i < path.length; i++) {
    const p = makeProjection(path[i - 1][0], path[i - 1][1]);
    s += Math.hypot(...p.toXY(path[i][0], path[i][1]));
  }
  return s;
}

// ---- Preparation -------------------------------------------------------------------------------------

// Regional elevation model, kept per analysed area (reruns don't download it again).
const regionalCache = { key: null, dem: null };

// Trace every lake and decide whether its path reaches the analysed area.
// lakes: [{ id, name, lon, lat, area, outline?, source, userPath? }]
export async function traceLakes(lakes, waterways, bbox, P = GLOF_DEFAULTS, { signal, onStatus } = {}) {
  const maxM = P.maxPathKm * 1000;
  const net = buildNetwork(waterways);
  const needDem = async () => {
    const k = bbox.join(',');
    if (regionalCache.key !== k) {
      onStatus?.('Downloading regional elevation for tracing lake outflows…');
      const pad = 0.35;
      regionalCache.dem = await loadDEM([bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad], { signal, maxZoom: 12, maxTiles: 64 });
      regionalCache.key = k;
    }
    return regionalCache.dem;
  };
  for (const lake of lakes) {
    lake.path = [];
    lake.method = '';
    if (lake.userPath?.length >= 2) {
      lake.path = lake.userPath;
      lake.method = 'drawn by you';
    } else {
      const out = net && networkOutlet(lake, net);
      if (out) {
        const r = followNetwork(net, out, maxM);
        lake.path = r.path;
        lake.method = 'OSM waterways';
        if (r.ended && r.length < maxM) {
          // Mapped network ends (often at the download edge): continue on terrain.
          const dem = await needDem();
          const end = r.path[r.path.length - 1];
          const t = traceTerrain(dem, end[0], end[1], maxM - r.length);
          if (t.path.length > 1) {
            lake.path = r.path.concat(t.path.slice(1));
            lake.method = 'OSM waterways + terrain';
          }
        }
      } else {
        const dem = await needDem();
        const o = terrainOutlet(lake, dem);
        lake.path = traceTerrain(dem, o[0], o[1], maxM).path;
        lake.method = 'terrain';
      }
    }
    lake.pathKm = pathLength(lake.path) / 1000;
    // Reaches the area if the path enters the analysed box (± 200 m).
    const m = 0.002;
    const idx = lake.path.findIndex(([x, y]) => x >= bbox[0] - m && x <= bbox[2] + m && y >= bbox[1] - m && y <= bbox[3] + m);
    lake.reaches = idx >= 0;
    lake.distToAreaKm = lake.reaches ? pathLength(lake.path.slice(0, idx + 1)) / 1000 : null;
  }
  return lakes;
}

// Segment index of the paths that reach the area, in the dataset's plane,
// with the distance along the path (from the lake) at each segment start.
export function pathIndex(ds, lakes) {
  const idx = new GridIndex(200);
  let n = 0;
  for (const lake of lakes) {
    if (!lake.reaches) continue;
    const size = 0.4 + 0.6 * scale(lake.area, 2e4, 5e5);
    let s = 0;
    const xy = lake.path.map(([lon, lat]) => ds.proj.toXY(lon, lat));
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1];
      const [bx, by] = xy[i];
      const len = Math.hypot(bx - ax, by - ay);
      idx.insert({ ax, ay, bx, by, s, len, size, lake }, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
      s += len;
      n++;
    }
  }
  return n ? idx : null;
}

// GLOF score (0–1) of one building: flood height at that point of the path
// minus the building's height above the path, scaled 0 m → 0 to 5 m → 1.
export function glofScore(p, ds, dem, idx, P = GLOF_DEFAULTS) {
  if (!idx) return 0;
  const C = P.corridor;
  const elev = dem.elev(...p.feature.center);
  if (!Number.isFinite(elev)) return 0;
  let best = 0;
  const near = new Map();
  idx.query(p.x - C, p.y - C, p.x + C, p.y + C, (sg) => {
    const hit = nearestOnSeg(p.x, p.y, sg.ax, sg.ay, sg.bx, sg.by);
    if (hit.d > C) return;
    const prev = near.get(sg.lake);
    if (!prev || hit.d < prev.hit.d) near.set(sg.lake, { hit, sg });
  });
  for (const { hit, sg } of near.values()) {
    const t = sg.len ? Math.hypot(hit.x - sg.ax, hit.y - sg.ay) / sg.len : 0;
    const s = sg.s + t * sg.len;
    const [lon, lat] = ds.proj.toLonLat(hit.x, hit.y);
    const channel = dem.minAround(lon, lat, 2);
    if (!Number.isFinite(channel)) continue;
    const height = Math.max(0, elev - channel);
    const H = Math.max(P.h30, P.h0 - ((P.h0 - P.h30) * s) / 30000);
    const v = scale(H - height, 0, 5) * sg.size;
    if (v > best) best = v;
  }
  return best;
}
