// Multi-hazard screening.
//
// Each hazard gives every building and facility a 0–1 score from open data:
//   river     flood depth for the 100-year level, from height above the nearest river
//   flash     flash / rain flooding: terrain hollows, flat ground and nearby streams or drains
//   landslide steepest nearby slope, local relief and undercutting by streams or road cuts
//   earthquake regional seismicity (USGS catalogue) × building vulnerability
//              (material, storeys, fragile type, steep or soft riverside ground)
//   coastal   ground below a chosen sea level within 10 km of the coast
//   glof      glacial lake outburst: homes along the traced outflow path of lakes that
//             drain through the area, scored by height above the path (glof.js)
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
import { parseGlofElements, glofScore, GLOF_DEFAULTS } from './glof.js';

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

const GLOF_WATERWAYS = 'river|stream|canal|tidal_channel|brook|drain';

// Glacier outlines and lakes within ~30 km, lakes near user-marked glaciers
// (markBoxes: [[w,s,e,n]]) and the regional stream network for tracing outflows.
function glacierQuery(bbox, markBoxes = []) {
  const g = pad(bbox, 0.3);
  const net = pad(bbox, 0.35);
  const b = (x) => `${x[1]},${x[0]},${x[3]},${x[2]}`;
  const water = `["natural"="water"]["water"!~"^(${WATER_EXCLUDE})$"]`;
  const marks = markBoxes.map((m) => `way${water}(${b(pad(m, 0.03))});relation${water}(${b(pad(m, 0.03))});`).join('');
  return `[out:json][timeout:180];
nwr["natural"="glacier"](${b(g)})->.g;
.g out tags geom qt;
(way${water}(around.g:3000);relation${water}(around.g:3000);${marks});
out tags geom qt;
way["waterway"~"^(${GLOF_WATERWAYS})$"](${b(net)});
out tags geom qt;`;
}

function coastQuery(bbox) {
  const c = pad(bbox, 0.1); // ~10 km for the coastline
  return `[out:json][timeout:120];
way["natural"="coastline"](${c[1]},${c[0]},${c[3]},${c[2]});
out tags geom qt;`;
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
      out.push({ lon, lat, area: lonLatArea(ring), outline: [ring], name, source: 'uploaded' });
    }
  }
  return out;
}

// Download only what the selected hazards need:
//   need.quakes → USGS catalogue (earthquake)
//   need.glof   → glaciers and nearby lakes from OSM, plus lake elevations (GLOF)
//   need.coast  → coastline from OSM (coastal flood)
// Returns just those parts, so the caller can keep and merge them.
export async function loadHazardContext(bbox, { need = {}, signal, onStatus, extraLakes = [], markBoxes = [] } = {}) {
  const [w, s, e, n] = bbox;
  const parts = {};
  const errors = {};
  const what = [need.quakes && 'earthquake catalogue', need.glof && 'glaciers and lakes', need.coast && 'coastline'].filter(Boolean);
  if (!what.length) return { parts, errors };
  onStatus?.(`Downloading ${what.join(', ')}…`);
  const [q, gl, co] = await Promise.allSettled([
    need.quakes ? fetchQuakes((w + e) / 2, (s + n) / 2, signal) : null,
    need.glof ? runQuery(glacierQuery(bbox, markBoxes), { signal }) : null,
    need.coast ? runQuery(coastQuery(bbox), { signal }) : null,
  ]);
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  if (need.quakes) {
    if (q.status === 'fulfilled') parts.quakes = q.value;
    else errors.earthquake = q.reason?.message ?? 'earthquake catalogue unavailable';
  }
  if (need.coast) {
    if (co.status === 'fulfilled') parts.coast = co.value.filter((el) => el.geometry).map((el) => el.geometry.filter(Boolean).map((p) => [p.lon, p.lat]));
    else errors.coastal = co.reason?.message ?? 'coastline unavailable';
  }
  if (need.glof) {
    if (gl.status === 'fulfilled') {
      const g = parseGlofElements(gl.value);
      parts.glaciers = g.glaciers.length;
      parts.glacierFeatures = g.glaciers;
      parts.waterways = g.waterways;
      // OSM lakes (40 largest) plus uploaded and user-marked lakes; look up elevations.
      let lakes = g.lakes.sort((a, b) => b.area - a.area).slice(0, 40).concat(extraLakes.map((l) => ({ ...l })));
      if (lakes.length) {
        onStatus?.(`Looking up elevation of ${lakes.length} glacial lake(s)…`);
        await Promise.all(lakes.map(async (l) => {
          try {
            const dem = await loadDEM([l.lon - 0.002, l.lat - 0.002, l.lon + 0.002, l.lat + 0.002], { signal });
            l.elev = dem.elev(l.lon, l.lat);
          } catch {
            l.elev = NaN;
          }
        }));
      }
      parts.lakes = lakes;
    } else {
      errors.glof = gl.reason?.message ?? 'glacier data unavailable';
    }
  }
  return { parts, errors };
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
  if (has('glof') && ctx.errors.glof) notes.glof = `Glacier data unavailable (${ctx.errors.glof}).`;
  else if (has('glof') && !ctx.lakes.length) notes.glof = ctx.glaciers
    ? `${ctx.glaciers} glaciers within ~30 km but no glacial lakes are mapped. Mark or upload lakes to assess GLOF.`
    : 'No glaciers or glacial lakes within ~30 km: not applicable.';
  else if (has('glof') && !P.glofIdx) {
    notes.glof = `${ctx.lakes.length} glacial lake(s) found, but none drains through this area: not applicable. See the traced paths on the map.`;
  }
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
  if (has('coastal') && !coastSegs) notes.coastal = ctx.errors.coastal ? `Coastline unavailable (${ctx.errors.coastal}).` : 'No coastline within ~10 km: not applicable.';
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

    if (has('glof') && P.glofIdx) {
      // Only lakes whose traced outflow passes through the area (see glof.js).
      hz.glof = glofScore(p, ds, dem, P.glofIdx, P.glof ?? GLOF_DEFAULTS);
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
export const LIKELIHOOD = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'];
export const IMPACT = ['Minimal', 'Minor', 'Moderate', 'Major', 'Severe'];
// Share of residents at high hazard that starts impact levels 2, 3, 4 and 5.
export const IMPACT_STEPS = [0.005, 0.02, 0.05, 0.15];

export function rating(score) {
  return score <= 4 ? 'Low' : score <= 9 ? 'Medium' : score <= 16 ? 'High' : 'Extreme';
}

// Likelihood × impact per hazard (both 1–5), with every intermediate value
// so the calculation can be shown and exported:
//   likelihood = 1 + floor(5 × p90), capped at 5, where p90 is the
//                90th-percentile hazard score across homes
//   impact     = 1 + number of IMPACT_STEPS reached by the share of residents
//                at high hazard (score ≥ HIGH), +1 (max 5) if a health,
//                education or emergency facility is at high hazard
//   score      = likelihood × impact → Low ≤ 4 < Medium ≤ 9 < High ≤ 16 < Extreme
export function riskMatrix(ds, keys) {
  const homes = ds.buildings.filter((b) => b.pop > 0 && b.hz);
  const popTotal = homes.reduce((a, b) => a + b.pop, 0);
  return keys.map((k) => {
    const vals = homes.map((b) => b.hz[k] ?? 0).sort((a, b) => a - b);
    const p90 = vals.length ? vals[Math.floor(0.9 * (vals.length - 1))] : 0;
    const mean = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
    const likelihood = 1 + Math.min(4, Math.floor(p90 * 5));
    const highHomes = homes.filter((b) => (b.hz[k] ?? 0) >= HIGH);
    const exposedPop = highHomes.reduce((a, b) => a + b.pop, 0);
    const exposedShare = popTotal ? exposedPop / popTotal : 0;
    const impactBase = 1 + IMPACT_STEPS.filter((t) => exposedShare >= t).length;
    const criticalFacilities = ds.facilities.filter((f) => (f.hz?.[k] ?? 0) >= HIGH && ['health', 'education', 'emergency'].includes(f.group));
    const critical = criticalFacilities.length > 0;
    const impact = Math.min(5, impactBase + (critical ? 1 : 0));
    const score = likelihood * impact;
    return {
      key: k, mean, p90, likelihood, highHomes: highHomes.length, exposedPop, exposedShare,
      impactBase, critical, criticalCount: criticalFacilities.length, impact, score, rating: rating(score),
    };
  });
}
