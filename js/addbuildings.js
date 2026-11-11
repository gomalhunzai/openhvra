// Fill gaps in OSM buildings with machine-learning footprints from the
// Overture Maps buildings theme (Microsoft ML Buildings, Google Open
// Buildings, Esri Community Maps), read from Overture's PMTiles archive.
//
// Overture already leaves out ML buildings that overlap its own copy of OSM,
// but that copy can be weeks old, so every candidate is checked again
// against the OSM buildings just loaded: any candidate that overlaps or
// touches an OSM footprint (or, in Light mode, an OSM bounding box, or a
// building mapped as a point) is dropped as a probable duplicate.

import { PMTiles } from './pmtiles.js';
import { decodePolygons } from './mvt.js';
import { buildingClass } from './osm.js';
import { lonLatArea, makeProjection, GridIndex, pointInRing } from './spatial.js';

export const OVERTURE_STAC = 'https://stac.overturemaps.org/catalog.json';
export const OVERTURE_FALLBACK_RELEASE = '2026-10-21.0';
export const OVERTURE_CREDIT = 'Overture Maps Foundation, buildings theme (ODbL 1.0), with Microsoft ML Buildings, Google Open Buildings and Esri Community Maps';
const Z = 14; // the most detailed zoom of the archive
const POINT_RADIUS_M = 5; // OSM buildings mapped as a point: ~80 m² around it

const tilesUrl = (release) => `https://tiles.overturemaps.org/${release}/buildings.pmtiles`;

// Latest Overture release from its catalogue, or the fallback if unreachable.
export async function latestRelease(fetchImpl = fetch, signal) {
  try {
    const res = await fetchImpl(OVERTURE_STAC, { signal });
    if (res.ok) return (await res.json()).latest ?? OVERTURE_FALLBACK_RELEASE;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }
  return OVERTURE_FALLBACK_RELEASE;
}

export function tileRange([w, s, e, n], z = Z) {
  const N = 2 ** z;
  const tx = (lon) => Math.min(N - 1, Math.max(0, Math.floor(((lon + 180) / 360) * N)));
  const ty = (lat) => {
    const r = (lat * Math.PI) / 180;
    return Math.min(N - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N)));
  };
  return { x0: tx(w), x1: tx(e), y0: ty(n), y1: ty(s) };
}

// Non-OSM Overture buildings touching bbox, one per Overture id (a building
// crossing a tile edge appears in both tiles: the larger piece is kept).
export async function fetchCandidates(bbox, { release, signal, onProgress, fetchImpl = fetch } = {}) {
  const rel = release ?? (await latestRelease(fetchImpl, signal));
  const pm = new PMTiles(tilesUrl(rel), fetchImpl);
  const { x0, x1, y0, y1 } = tileRange(bbox);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  const byId = new Map();
  let bytes = 0;
  let done = 0;
  await Promise.all(jobs.map(async ([x, y]) => {
    const t = await pm.getTile(Z, x, y, signal);
    onProgress?.(++done, jobs.length);
    if (!t) return;
    bytes += t.length;
    for (const f of decodePolygons(t, 'building', Z, x, y)) {
      const p = f.properties;
      if (p['@geometry_source'] === 'OpenStreetMap' || p.is_underground) continue;
      const outer = f.polygons[0][0];
      const area = lonLatArea(outer);
      const prev = byId.get(p.id);
      if (!prev || area > prev.area) byId.set(p.id, { props: p, ring: outer, area });
    }
  }));
  return { release: rel, tiles: jobs.length, bytes, candidates: [...byId.values()] };
}

// ---- Overlap test (local metres) ----------------------------------------------------------

function segCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function ringBox(r) {
  let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
  for (const [x, y] of r) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

function distToRing(x, y, r) {
  let best = Infinity;
  for (let i = 1; i < r.length; i++) {
    const [ax, ay] = r[i - 1];
    const [bx, by] = r[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

// Whether two rings (closed, local metres) overlap or touch: an edge crosses,
// or a vertex of one lies inside the other.
export function ringsOverlap(a, b) {
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) if (segCross(a[i - 1], a[i], b[j - 1], b[j])) return true;
  return a.some(([x, y]) => pointInRing(x, y, b)) || b.some(([x, y]) => pointInRing(x, y, a));
}

// OSM building shapes for the overlap test, in local metres.
function osmShape(f, proj) {
  const g = f.geometry;
  if (g.type === 'Polygon') return { ring: g.coordinates[0].map(([lon, lat]) => proj.toXY(lon, lat)) };
  const bb = f.properties.bbox;
  if (bb) {
    const [w, s, e, n] = bb;
    return { ring: [[w, s], [e, s], [e, n], [w, n], [w, s]].map(([lon, lat]) => proj.toXY(lon, lat)) };
  }
  return { point: proj.toXY(...g.coordinates) };
}

// Splits candidates into those to add and probable duplicates of OSM buildings.
// osmFeatures: the OSM building features loaded; contains(lon, lat): area test.
export function removeOverlaps(candidates, osmFeatures, contains, center) {
  const proj = makeProjection(...center);
  const index = new GridIndex(50);
  for (const f of osmFeatures) {
    const s = osmShape(f, proj);
    if (s.ring) {
      s.box = ringBox(s.ring);
      index.insert(s, ...s.box);
    } else {
      const [x, y] = s.point;
      index.insert(s, x - POINT_RADIUS_M, y - POINT_RADIUS_M, x + POINT_RADIUS_M, y + POINT_RADIUS_M);
    }
  }
  const keep = [];
  let duplicates = 0;
  let outside = 0;
  for (const c of candidates) {
    const ring = c.ring.map(([lon, lat]) => proj.toXY(lon, lat));
    const [cx, cy] = centroid(c.ring);
    if (!contains(cx, cy)) {
      outside++;
      continue;
    }
    const [w, s, e, n] = ringBox(ring);
    let hit = false;
    index.query(w, s, e, n, (o) => {
      if (hit) return;
      if (o.ring) {
        if (o.box[0] <= e && o.box[2] >= w && o.box[1] <= n && o.box[3] >= s && ringsOverlap(ring, o.ring)) hit = true;
      } else if (pointInRing(o.point[0], o.point[1], ring) || distToRing(o.point[0], o.point[1], ring) <= POINT_RADIUS_M) hit = true;
    });
    if (hit) duplicates++;
    else keep.push(c);
  }
  return { keep, duplicates, outside };
}

function centroid(ring) {
  let x = 0;
  let y = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [x / n, y / n];
}

const SOURCE_SHORT = { 'Microsoft ML Buildings': 'Microsoft', 'Google Open Buildings': 'Google', 'Esri Community Maps': 'Esri' };

// Candidates kept → building features in the same form as parseOSM's.
export function toBuildingFeatures(keep, firstFid) {
  let fid = firstFid;
  return keep.map((c) => {
    const p = c.props;
    const cls = p.class ? buildingClass({ building: p.class }) : 'unknown';
    const levels = Number.isFinite(p.num_floors) && p.num_floors > 0 && p.num_floors < 200 ? p.num_floors : null;
    const source = SOURCE_SHORT[p['@geometry_source']] ?? p['@geometry_source'] ?? 'Overture';
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [c.ring] },
      center: centroid(c.ring),
      properties: {
        fid: ++fid, osm_id: null, kind: 'building', cls, type: p.class ?? 'building', name: '',
        levels, area: Math.round(c.area), material: '', source, overture_id: p.id,
      },
    };
  });
}

export function sourceCounts(features) {
  const out = {};
  for (const f of features) out[f.properties.source] = (out[f.properties.source] ?? 0) + 1;
  return out;
}
