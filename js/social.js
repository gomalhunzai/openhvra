// Social vulnerability.
//
// 1. A building-level Social Vulnerability Index (SVI, 0–1) from proxies that
//    can be derived from OpenStreetMap: access to health care, to emergency
//    services and shelters, and to roads; housing fragility; and crowding.
//    An optional census layer (polygons with an indicator such as poverty %)
//    can be uploaded and joined to buildings. Indicators are scored 0 (least
//    vulnerable) to 1 (most vulnerable) and averaged with equal weights.
// 2. Vulnerable population groups (children, elderly, people with
//    disabilities, people in poverty) estimated by applying shares, by
//    default national figures from the World Bank, to the modelled residents.

import { pointInRing, ringBBox } from './spatial.js';

export const SVI_INDICATORS = {
  health: { label: 'Distance to health facility', note: '0 at ≤ 500 m, 1 at ≥ 5 km' },
  emergency: { label: 'Distance to emergency services or shelter', note: '0 at ≤ 500 m, 1 at ≥ 5 km' },
  road: { label: 'Distance to a road', note: '0 at ≤ 50 m, 1 at ≥ 500 m' },
  housing: { label: 'Fragile housing', note: 'huts, sheds, tents, containers = 1; small single-storey = 0.5' },
  crowding: { label: 'Crowding', note: 'residents per hectare within 100 m: 0 at ≤ 50, 1 at ≥ 400' },
  census: { label: 'Census indicator (uploaded)', note: 'scaled from lowest to highest unit' },
};

// Second sequential context: orange, one hue light → dark (flood depth uses blue).
export const SVI_CLASSES = [
  { max: 0.2, label: 'Very low', color: '#fde3cf' },
  { max: 0.4, label: 'Low', color: '#f9b98f' },
  { max: 0.6, label: 'Moderate', color: '#eb6834' },
  { max: 0.8, label: 'High', color: '#b8481b' },
  { max: Infinity, label: 'Very high', color: '#7a2c0c' },
];

export function sviClass(v) {
  return SVI_CLASSES.findIndex((c) => v < c.max || c.max === Infinity);
}

export const GROUPS = {
  children: { label: 'Children (0–14)', wb: 'SP.POP.0014.TO.ZS' },
  elderly: { label: 'Elderly (65+)', wb: 'SP.POP.65UP.TO.ZS' },
  disability: { label: 'People with disabilities', wb: null },
  poverty: { label: 'People in extreme poverty', wb: 'SI.POV.DDAY' },
};
// WHO (2023): about 16% of the world's population lives with a significant disability.
export const DEFAULT_SHARES = { children: 25, elderly: 7, disability: 16, poverty: 10 };

const FRAGILE = new Set(['hut', 'shed', 'cabin', 'tent', 'static_caravan', 'container', 'construction', 'ruins', 'shack', 'houseboat']);

const scale = (v, lo, hi) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));

// Country (ISO2) for a location, then the most recent World Bank values.
export async function fetchCountryShares(lon, lat, outer) {
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const geo = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=3&accept-language=en&lat=${lat}&lon=${lon}`, { signal })).json();
  const iso2 = geo.address?.country_code;
  if (!iso2) throw new Error('could not identify the country for this area');
  const out = { country: geo.address.country, values: {} };
  await Promise.all(Object.entries(GROUPS).filter(([, g]) => g.wb).map(async ([k, g]) => {
    try {
      const res = await fetch(`https://api.worldbank.org/v2/country/${iso2}/indicator/${g.wb}?format=json&mrnev=1`, { signal });
      const row = (await res.json())[1]?.[0];
      if (row?.value != null) out.values[k] = { value: row.value, year: row.date };
    } catch (err) {
      if (outer?.aborted) throw err; // a single slow or missing indicator is skipped
    }
  }));
  return out;
}

export function groupCounts(pop, shares) {
  return Object.fromEntries(Object.keys(GROUPS).map((k) => [k, (pop * (shares[k] ?? 0)) / 100]));
}

// Prepare an uploaded census layer: features with a numeric field → polygons
// projected into the dataset's plane, each with a 0–1 score.
export function prepareCensus(ds, features, field, higherIsWorse) {
  const units = [];
  for (const f of features) {
    const v = parseFloat(f.properties?.[field]);
    if (!Number.isFinite(v)) continue;
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const p of polys) {
      const rings = p.map((r) => r.map(([lon, lat]) => ds.proj.toXY(lon, lat)));
      units.push({ rings, bbox: ringBBox(rings[0]), value: v });
    }
  }
  if (!units.length) throw new Error(`no polygons with a numeric "${field}" value`);
  const vals = units.map((u) => u.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  for (const u of units) {
    const s = hi > lo ? (u.value - lo) / (hi - lo) : 0.5;
    u.score = higherIsWorse ? s : 1 - s;
  }
  return { units, field, lo, hi, higherIsWorse };
}

function censusScore(census, x, y) {
  for (const u of census.units) {
    const [w, s, e, n] = u.bbox;
    if (x < w || x > e || y < s || y > n) continue;
    if (pointInRing(x, y, u.rings[0]) && !u.rings.slice(1).some((h) => pointInRing(x, y, h))) return u;
  }
  return null;
}

// Compute b.svi (0–1) and b.sviParts for every building. `use` is a Set of
// indicator keys; `census` is the result of prepareCensus or null.
export function computeSVI(ds, use, census) {
  const isHealth = (p) => p.kind === 'facility' && p.group === 'health';
  const isEmergency = (p) => p.kind === 'facility' && p.group === 'emergency';
  const isRoad = (l) => l.kind === 'road' && l.cls !== 'path';
  const hasRoads = ds.lines.some(isRoad);
  const R = 100;
  const ha = (Math.PI * R * R) / 1e4;
  for (const b of ds.buildings) {
    const parts = {};
    if (use.has('health')) {
      const n = ds.nearestPoint(b.x, b.y, isHealth, 5000);
      parts.health = scale(n ? n.d : 5000, 500, 5000);
      b.distHealth = n ? n.d : null;
    }
    if (use.has('emergency')) {
      const n = ds.nearestPoint(b.x, b.y, isEmergency, 5000);
      parts.emergency = scale(n ? n.d : 5000, 500, 5000);
      b.distEmergency = n ? n.d : null;
    }
    if (use.has('road') && hasRoads) {
      const n = ds.nearest(b.x, b.y, isRoad, 500);
      parts.road = scale(n ? n.d : 500, 50, 500);
    }
    if (use.has('housing')) {
      parts.housing = FRAGILE.has(b.type) ? 1 : b.footprint < 40 && b.floors <= 1 ? 0.5 : 0;
    }
    if (use.has('crowding')) {
      let residents = 0;
      ds.pointIndex.query(b.x - R, b.y - R, b.x + R, b.y + R, (p) => {
        if (p.kind === 'building' && Math.hypot(p.x - b.x, p.y - b.y) <= R) residents += p.pop;
      });
      parts.crowding = scale(residents / ha, 50, 400);
    }
    if (use.has('census') && census) {
      const u = censusScore(census, b.x, b.y);
      if (u) {
        parts.census = u.score;
        b.censusValue = u.value;
      }
    }
    const vals = Object.values(parts);
    b.sviParts = parts;
    b.svi = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
  }
}

// Assign b.sviClass (0–4) to homes. 'relative' ranks homes within the study
// area into fifths (the SoVI convention: the top 20% are 'very high');
// 'absolute' uses fixed 0.2 steps, comparable between areas.
export function classifySVI(ds, mode) {
  const homes = ds.buildings.filter((b) => b.pop > 0 && b.svi != null);
  let breaks = SVI_CLASSES.slice(0, -1).map((c) => c.max);
  if (mode === 'relative' && homes.length) {
    const v = homes.map((b) => b.svi).sort((a, b) => a - b);
    breaks = [0.2, 0.4, 0.6, 0.8].map((q) => v[Math.min(v.length - 1, Math.floor(q * v.length))]);
  }
  for (const b of ds.buildings) {
    if (b.svi == null) {
      b.sviClass = null;
      continue;
    }
    const i = breaks.findIndex((t) => b.svi < t);
    b.sviClass = i < 0 ? breaks.length : i;
  }
  return breaks;
}

// Residents and buildings per SVI class, optionally limited by `filter`.
export function sviSummary(ds, filter = () => true) {
  const classes = SVI_CLASSES.map(() => ({ buildings: 0, pop: 0 }));
  const sums = {};
  const counts = {};
  let popTotal = 0;
  for (const b of ds.buildings) {
    if (b.svi == null || b.pop <= 0 || !filter(b)) continue;
    const c = classes[b.sviClass ?? sviClass(b.svi)];
    c.buildings++;
    c.pop += b.pop;
    popTotal += b.pop;
    for (const [k, v] of Object.entries(b.sviParts)) {
      sums[k] = (sums[k] ?? 0) + v * b.pop;
      counts[k] = (counts[k] ?? 0) + b.pop;
    }
  }
  const means = Object.fromEntries(Object.keys(sums).map((k) => [k, sums[k] / counts[k]]));
  return { classes, popTotal, means };
}
