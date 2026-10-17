// Multi-hazard screening.
//
// Each hazard gives every building and facility a 0–1 score from open data:
//   river     flood depth for the 100-year level, from height above the nearest river
//   flash     flash / rain flooding: terrain hollows, flat ground and nearby streams or drains
//   landslide steepest nearby slope, local relief and undercutting by streams or road cuts
//   earthquake regional seismicity (USGS catalogue) × building vulnerability
//              (material, storeys, fragile type, steep or soft riverside ground)
//   coastal   ground below a chosen sea level within 10 km of the coast
//   glof      glacial lake outburst: valley-floor homes below and within 30 km of a glacial lake
//   avalanche steep snow-prone slopes above, using the alpha-angle runout rule
// The multi-hazard index combines them as 1 − Π(1 − wᵢ·sᵢ′), so one severe
// hazard stays severe and several moderate ones add up. sᵢ′ rescales scores
// so that background values below 0.2 (present everywhere in mountain
// terrain) do not accumulate into a false "high". Combined risk is the
// geometric mean of the multi-hazard index and social vulnerability (as in INFORM).

import { SOURCES } from './analysis.js';
import { runQuery } from './osm.js';
import { loadDEM } from './risk.js';
import { GridIndex, nearestOnSeg, lonLatArea } from './spatial.js';

export const HAZARDS = {
  river: { label: 'River flood', short: 'River flood' },
  flash: { label: 'Flash / rain flood', short: 'Flash flood' },
  landslide: { label: 'Landslide', short: 'Landslide' },
  earthquake: { label: 'Earthquake', short: 'Earthquake' },
  coastal: { label: 'Coastal flood', short: 'Coastal' },
  glof: { label: 'Glacial lake outburst (GLOF)', short: 'GLOF' },
  avalanche: { label: 'Snow avalanche', short: 'Avalanche' },
};
export const HIGH = 0.5; // score at or above which a hazard counts as "high"

// Third sequential context: red, one hue light → dark (blue = flood depth, orange = SVI).
export const SCORE_CLASSES = [
  { max: 0.2, label: 'Very low', color: '#fbd9d8' },
  { max: 0.4, label: 'Low', color: '#f4a3a1' },
  { max: 0.6, label: 'Moderate', color: '#e34948' },
  { max: 0.8, label: 'High', color: '#ad2b2b' },
  { max: Infinity, label: 'Very high', color: '#6b1414' },
];
export const scoreClass = (v) => SCORE_CLASSES.findIndex((c) => v < c.max);

const scale = (v, lo, hi) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
const pad = ([w, s, e, n], d) => [w - d, s - d, e + d, n + d];

// ---- Context data: earthquakes, glaciers, glacial lakes, coastline ---------------------------

const USGS = 'https://earthquake.usgs.gov/fdsnws/event/1';

async function fetchQuakes(lon, lat, signal) {
  const base = `format=geojson&latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`;
  const get = async (q) => (await fetch(`${USGS}/${q}`, { signal })).json();
  const [count, near, region] = await Promise.all([
    get(`count?${base}&maxradiuskm=150&minmagnitude=5&starttime=1973-01-01`),
    get(`query?${base}&maxradiuskm=100&minmagnitude=5&starttime=1900-01-01&orderby=magnitude&limit=1`),
    get(`query?${base}&maxradiuskm=300&minmagnitude=5.5&starttime=1900-01-01&orderby=magnitude&limit=8`),
  ]);
  const years = new Date().getFullYear() - 1973;
  const n150 = count.count ?? 0;
  const rate = n150 / years;
  const maxNear = near.features?.[0];
  const ev = (f) => {
    const [x, y, depth] = f.geometry.coordinates;
    const dist = Math.hypot((x - lon) * 111.32 * Math.cos((lat * Math.PI) / 180), (y - lat) * 110.57);
    return { mag: f.properties.mag, place: f.properties.place, year: new Date(f.properties.time).getUTCFullYear(), depth, dist };
  };
  // Hazard level: frequent moderate events or a large event close by.
  const rateScore = scale(Math.log10(Math.max(rate, 1e-4)), Math.log10(0.02), 0);
  const magScore = maxNear ? scale(maxNear.properties.mag, 5, 7.5) : 0;
  return {
    n150, years, rate,
    maxNear: maxNear ? ev(maxNear) : null,
    largest: (region.features ?? []).map(ev),
    score: Math.max(rateScore, magScore),
  };
}

const WATER_EXCLUDE = 'river|canal|stream|ditch|drain|wastewater|reflecting_pool|fountain|moat|lock';

function contextQuery(bbox) {
  const g = pad(bbox, 0.3); // ~30 km for glaciers and their lakes
  const c = pad(bbox, 0.1); // ~10 km for the coastline
  const b = (x) => `${x[1]},${x[0]},${x[3]},${x[2]}`;
  return `[out:json][timeout:120];
nwr["natural"="glacier"](${b(g)})->.g;
.g out tags bb qt;
(way["natural"="water"]["water"!~"^(${WATER_EXCLUDE})$"](around.g:3000);relation["natural"="water"]["water"!~"^(${WATER_EXCLUDE})$"](around.g:3000););
out tags bb qt;
way["natural"="coastline"](${b(c)});
out tags geom qt;`;
}

function boundsLake(el) {
  const { minlat, minlon, maxlat, maxlon } = el.bounds;
  return {
    lon: (minlon + maxlon) / 2,
    lat: (minlat + maxlat) / 2,
    area: 0.6 * lonLatArea([[minlon, minlat], [maxlon, minlat], [maxlon, maxlat], [minlon, maxlat]]),
    name: el.tags?.name ?? '',
    source: 'OpenStreetMap',
  };
}

// Lakes from an uploaded inventory (points or polygons).
export function lakesFromFeatures(features) {
  const out = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    const name = f.properties?.name ?? f.properties?.Name ?? f.properties?.GL_ID ?? '';
    if (g.type === 'Point') out.push({ lon: g.coordinates[0], lat: g.coordinates[1], area: +(f.properties?.area ?? f.properties?.Area ?? 0) || 1e5, name, source: 'uploaded' });
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const p of polys) {
      const ring = p[0];
      const n = ring.length - 1;
      const lon = ring.slice(0, n).reduce((a, c) => a + c[0], 0) / n;
      const lat = ring.slice(0, n).reduce((a, c) => a + c[1], 0) / n;
      out.push({ lon, lat, area: lonLatArea(ring), name, source: 'uploaded' });
    }
  }
  return out;
}

// Download everything the hazard models need besides the elevation model.
export async function loadHazardContext(bbox, { signal, onStatus, extraLakes = [] } = {}) {
  const [w, s, e, n] = bbox;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const ctx = { quakes: null, glaciers: 0, lakes: [], coast: [], errors: {} };
  onStatus?.('Downloading earthquake catalogue, glaciers, lakes and coastline…');
  const [q, osm] = await Promise.allSettled([fetchQuakes(cx, cy, signal), runQuery(contextQuery(bbox), { signal })]);
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  if (q.status === 'fulfilled') ctx.quakes = q.value;
  else ctx.errors.earthquake = q.reason?.message ?? 'earthquake catalogue unavailable';
  if (osm.status === 'fulfilled') {
    for (const el of osm.value) {
      if (el.tags?.natural === 'glacier') ctx.glaciers++;
      else if (el.tags?.natural === 'water' && el.bounds) ctx.lakes.push(boundsLake(el));
      else if (el.tags?.natural === 'coastline' && el.geometry) ctx.coast.push(el.geometry.filter(Boolean).map((p) => [p.lon, p.lat]));
    }
  } else {
    ctx.errors.glof = ctx.errors.coastal = osm.reason?.message ?? 'OpenStreetMap context unavailable';
  }
  ctx.lakes.push(...extraLakes);
  // Keep the 40 largest lakes and look up their elevation.
  ctx.lakes = ctx.lakes.sort((a, b) => b.area - a.area).slice(0, 40);
  if (ctx.lakes.length) {
    onStatus?.(`Looking up elevation of ${ctx.lakes.length} glacial lake(s)…`);
    await Promise.all(ctx.lakes.map(async (l) => {
      try {
        const dem = await loadDEM([l.lon - 0.002, l.lat - 0.002, l.lon + 0.002, l.lat + 0.002], { signal });
        l.elev = dem.elev(l.lon, l.lat);
      } catch {
        l.elev = NaN;
      }
    }));
    ctx.lakes = ctx.lakes.filter((l) => Number.isFinite(l.elev));
  }
  return ctx;
}

// ---- Scoring ----------------------------------------------------------------------------------

const DIRS = Array.from({ length: 16 }, (_, i) => [Math.cos((i * Math.PI) / 8), Math.sin((i * Math.PI) / 8)]);
const DIRS8 = DIRS.filter((_, i) => i % 2 === 0);

function slopeAt(dem, px, py, mpp) {
  const k = 2;
  const dx = (dem.sample(px + k, py) - dem.sample(px - k, py)) / (2 * k * mpp);
  const dy = (dem.sample(px, py + k) - dem.sample(px, py - k)) / (2 * k * mpp);
  return (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
}

function materialScore(m, type) {
  if (/^(hut|shed|tent|container|cabin|shack|static_caravan)$/.test(type)) return 1;
  if (/mud|adobe|earth|rammed|cob|stone|rubble|brick|masonry|block|unreinforced/i.test(m)) return 0.9;
  if (/wood|timber|bamboo|log/i.test(m)) return 0.5;
  if (/concrete|reinforced|steel|metal/i.test(m)) return 0.35;
  return 0.65;
}

// P: { use: Set of hazard keys, floodLevel, coastLevel, snowLine }
// Sets p.hz = { key: score } on every point and returns per-hazard notes.
export function scoreHazards(ds, dem, ctx, P) {
  const anyWater = SOURCES.water_all.pred;
  const river = SOURCES.water_river.pred;
  const stream = (l) => l.kind === 'water' && l.cls === 'stream';
  const road = (l) => l.kind === 'road' && l.cls !== 'path';
  const notes = {};
  const has = (k) => P.use.has(k);

  // Applicability checks.
  if (has('river') && !ds.lines.some(river)) notes.river = 'No rivers or canals mapped in this area.';
  if (has('earthquake') && !ctx.quakes) notes.earthquake = `Earthquake catalogue unavailable (${ctx.errors.earthquake ?? 'unknown error'}).`;
  if (has('glof') && !ctx.lakes.length) notes.glof = ctx.glaciers
    ? `${ctx.glaciers} glaciers within ~30 km but no glacial lakes are mapped. Upload a lake inventory to assess GLOF.`
    : 'No glaciers within ~30 km: not applicable.';
  let maxElev = -Infinity;
  for (const t of dem.tiles) if (t) for (let i = 0; i < t.length; i += 97) if (t[i] > maxElev) maxElev = t[i];
  if (has('avalanche') && maxElev < P.snowLine) notes.avalanche = `No terrain above the snow line (${P.snowLine} m) nearby: not applicable.`;

  // Coastline segments in the dataset plane.
  const coastIdx = new GridIndex(500);
  let coastSegs = 0;
  for (const line of ctx.coast) {
    const xy = line.map(([lon, lat]) => ds.proj.toXY(lon, lat));
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1];
      const [bx, by] = xy[i];
      coastIdx.insert({ ax, ay, bx, by }, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
      coastSegs++;
    }
  }
  if (has('coastal') && !coastSegs) notes.coastal = 'No coastline within ~10 km: not applicable.';
  const lakes = ctx.lakes.map((l) => ({ ...l, xy: ds.proj.toXY(l.lon, l.lat) }));
  const eqScore = ctx.quakes?.score ?? 0;

  for (const p of ds.points) {
    const [lon, lat] = p.feature.center;
    const [px, py] = dem.pixel(lon, lat);
    const mpp = dem.metresPerPixel(lat);
    const elev = dem.sample(px, py);
    const hz = {};
    p.hz = hz;
    if (!Number.isFinite(elev)) continue;
    const at = (dist, [dx, dy]) => dem.sample(px + (dx * dist) / mpp, py - (dy * dist) / mpp);
    const slope = slopeAt(dem, px, py, mpp);

    // Height above the nearest waterway (any) and above the nearest river.
    const nw = ds.nearest(p.x, p.y, anyWater, 1000);
    const handAll = nw ? Math.max(0, elev - dem.minAround(nw.lonlat[0], nw.lonlat[1], 2)) : Infinity;

    if (has('river') && !notes.river) {
      const nr = ds.nearest(p.x, p.y, river, 1000);
      const hand = nr ? Math.max(0, elev - dem.minAround(nr.lonlat[0], nr.lonlat[1], 2)) : Infinity;
      hz.river = scale(P.floodLevel - hand, 0, 2);
    }

    if (has('flash')) {
      let ring = 0;
      for (const d of DIRS8) ring += at(150, d);
      const tpi = elev - ring / 8; // negative = hollow
      const ns = ds.nearest(p.x, p.y, stream, 300);
      const depression = scale(-tpi, 0.5, 5);
      const flat = 1 - scale(slope, 2, 10);
      const streamProx = ns ? 1 - scale(ns.d, 30, 300) : 0;
      hz.flash = Math.min(1, 0.5 * depression + 0.2 * flat * depression + 0.3 * streamProx + (handAll < 2 ? 0.2 : 0));
    }

    if (has('landslide')) {
      let maxSlope = slope;
      let lo = elev;
      let hi = elev;
      for (const d of DIRS8) {
        for (const dist of [30, 60]) {
          const [qx, qy] = [px + (d[0] * dist) / mpp, py - (d[1] * dist) / mpp];
          const sl = slopeAt(dem, qx, qy, mpp);
          if (sl > maxSlope) maxSlope = sl;
        }
        const e150 = at(150, d);
        if (e150 < lo) lo = e150;
        if (e150 > hi) hi = e150;
      }
      const relief = scale(hi - lo, 10, 80);
      const nwd = nw ? 1 - scale(nw.d, 50, 400) : 0;
      const nrd = ds.nearest(p.x, p.y, road, 200);
      const roadCut = nrd ? 1 - scale(nrd.d, 20, 200) : 0;
      hz.landslide = scale(maxSlope, 10, 35) * (0.6 + 0.4 * ((relief + nwd + roadCut) / 3));
      p.slopeMax = maxSlope;
    }

    if (has('earthquake') && ctx.quakes) {
      const floors = p.floors ?? 2;
      const height = floors <= 2 ? 0.4 : floors <= 5 ? 0.7 : 0.8;
      const site = slope >= 25 ? 0.9 : handAll < 5 && nw && nw.d < 300 ? 0.8 : 0.4;
      const vuln = 0.45 * materialScore(p.material ?? '', p.type ?? '') + 0.25 * height + 0.3 * site;
      hz.earthquake = eqScore * vuln;
    }

    if (has('coastal') && coastSegs) {
      let best = Infinity;
      const R = 10000;
      coastIdx.query(p.x - R, p.y - R, p.x + R, p.y + R, (sg) => {
        const { d } = nearestOnSeg(p.x, p.y, sg.ax, sg.ay, sg.bx, sg.by);
        if (d < best) best = d;
      });
      hz.coastal = best <= R ? scale(P.coastLevel - elev, 0, 2) : 0;
    }

    if (has('glof') && lakes.length) {
      const valley = 1 - scale(handAll, 5, 20);
      let s = 0;
      if (valley > 0) {
        for (const l of lakes) {
          const dist = Math.hypot(l.xy[0] - p.x, l.xy[1] - p.y);
          if (dist > 30000 || l.elev - elev < 100) continue;
          const v = valley * (1 - scale(dist, 5000, 30000)) * (0.4 + 0.6 * scale(l.area, 2e4, 5e5));
          if (v > s) s = v;
        }
      }
      hz.glof = s;
    }

    if (has('avalanche') && !notes.avalanche) {
      // Alpha angle: steep (28–55°) snow-prone terrain above, seen at ≥ 22° from the building.
      let alpha = 0;
      for (const d of DIRS) {
        for (let dist = 100; dist <= 1200; dist += 100) {
          const e2 = at(dist, d);
          if (!(e2 >= P.snowLine) || e2 - elev < 50) continue;
          const sl = slopeAt(dem, px + (d[0] * dist) / mpp, py - (d[1] * dist) / mpp, mpp);
          if (sl < 28 || sl > 55) continue;
          const a = (Math.atan((e2 - elev) / dist) * 180) / Math.PI;
          if (a > alpha) alpha = a;
        }
      }
      hz.avalanche = scale(alpha, 18, 30);
    }
  }
  return notes;
}

// Multi-hazard index and combined risk; cheap, so rerun when weights,
// population or social vulnerability change.
export const NOISE_FLOOR = 0.2;

// `vuln(p)` returns the 0–1 vulnerability used for combined risk, or null.
export function combine(ds, weights, notes, vuln = null) {
  const keys = Object.keys(weights).filter((k) => !notes[k]);
  for (const p of ds.points) {
    let prod = 1;
    let highs = 0;
    for (const k of keys) {
      const s = p.hz?.[k];
      if (s == null) continue;
      prod *= 1 - Math.min(1, weights[k] * scale(s, NOISE_FLOOR, 1));
      if (s >= HIGH) highs++;
    }
    p.mhi = p.hz ? 1 - prod : null;
    p.highHazards = highs;
    const v = vuln?.(p);
    p.risk = p.mhi != null && v != null ? Math.sqrt(p.mhi * v) : null;
  }
  return keys;
}

// Likelihood × impact matrix per hazard (both 1–5).
export function riskMatrix(ds, keys) {
  const homes = ds.buildings.filter((b) => b.pop > 0 && b.hz);
  const pop = homes.reduce((a, b) => a + b.pop, 0) || 1;
  return keys.map((k) => {
    const vals = homes.map((b) => b.hz[k] ?? 0).sort((a, b) => a - b);
    const p90 = vals.length ? vals[Math.floor(0.9 * (vals.length - 1))] : 0;
    const likelihood = 1 + Math.min(4, Math.floor(p90 * 5));
    const exposed = homes.filter((b) => (b.hz[k] ?? 0) >= HIGH).reduce((a, b) => a + b.pop, 0) / pop;
    let impact = 1 + [0.005, 0.02, 0.05, 0.15].filter((t) => exposed >= t).length;
    const critical = ds.facilities.some((f) => (f.hz?.[k] ?? 0) >= HIGH && ['health', 'education', 'emergency'].includes(f.group));
    if (critical) impact = Math.min(5, impact + 1);
    const score = likelihood * impact;
    const rating = score <= 4 ? 'Low' : score <= 9 ? 'Medium' : score <= 16 ? 'High' : 'Extreme';
    return { key: k, likelihood, impact, rating, exposedShare: exposed, critical };
  });
}
