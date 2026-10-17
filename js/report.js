// Full analysis export: one ZIP with a readable summary, every selected
// parameter, per-feature tables carrying every analysis value, summary
// tables (incl. the risk-matrix calculation) and the map layers as GeoJSON.

import { BUILDING_CLASSES, FACILITY_GROUPS, CRITICAL_GROUPS } from './osm.js';
import { SOURCES } from './analysis.js';
import { expectedAnnual } from './risk.js';
import { SVI_INDICATORS, SVI_CLASSES, GROUPS, groupCounts, sviSummary } from './social.js';
import { HAZARDS, HIGH, NOISE_FLOOR, LIKELIHOOD, IMPACT, IMPACT_STEPS, SCORE_CLASSES, scoreClass } from './hazards.js';

const FFLATE = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm';

const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r6 = (v) => Math.round(v * 1e6) / 1e6;

export function toCSV(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
}

// ---- Per-feature rows ---------------------------------------------------------------------------

function exposureIndex(S) {
  const m = new Map();
  for (const h of S.exposure?.all ?? []) m.set(h.p, h);
  return m;
}

export function featureRow(p, S, exp = exposureIndex(S)) {
  const [lon, lat] = p.feature.center;
  const row = { osm_id: p.osm_id, osm_url: `https://www.openstreetmap.org/${p.osm_id}`, lon: r6(lon), lat: r6(lat), name: p.name };
  if (p.kind === 'building') {
    Object.assign(row, {
      class: p.cls, class_label: BUILDING_CLASSES[p.cls], type: p.type, material: p.material || null,
      storeys: p.floors, storeys_from_osm: p.levels != null, footprint_m2: Math.round(p.footprint),
      footprint_estimated: p.area == null || S.loadOpts?.buildings === 'light', floor_area_m2: Math.round(p.footprint * p.floors), residents: r1(p.pop),
    });
  } else {
    Object.assign(row, { group: p.group, group_label: FACILITY_GROUPS[p.group]?.label, type: p.type, critical: CRITICAL_GROUPS.has(p.group) });
  }
  if (S.exposure) {
    const h = exp.get(p);
    row.exp_source = S.exposure.sourceKey;
    row.exp_within_m = S.exposure.dist;
    row.exp_distance_m = h ? Math.round(h.d) : null;
    if (S.exposure.elevation) {
      row.exp_height_above_water_m = h ? r1(h.height) : null;
      row.exp_bank_angle_deg = h?.bank != null ? Math.round(h.bank) : null;
    }
    row.exp_class = h ? { flood: S.exposure.elevation ? 'flood-exposed' : 'within distance', bank: 'steep bank', high: 'higher ground' }[h.ex] : 'outside distance';
  }
  if (S.risk) {
    row.flood_height_above_river_m = r1(p.hand);
    row.flood_river_distance_m = p.riverDist != null ? Math.round(p.riverDist) : null;
    if (p.kind === 'building') row.flood_value = Math.round(p.value ?? 0);
    S.risk.scenarios.forEach((s, i) => {
      row[`flood_depth_${s.rp}yr_m`] = p.depths ? r2(p.depths[i]) : null;
      if (p.kind === 'building') row[`flood_loss_${s.rp}yr`] = p.losses ? Math.round(p.losses[i]) : 0;
    });
    if (p.kind === 'building') row.flood_avg_annual_loss = p.losses ? Math.round(expectedAnnual(S.risk.scenarios.map((s, i) => ({ rp: s.rp, v: p.losses[i] })))) : 0;
    if (p.kind === 'building') row.slope_deg = r1(p.slope);
  }
  if (S.svi && p.kind === 'building') {
    row.svi = r2(p.svi);
    row.svi_class = p.sviClass != null ? SVI_CLASSES[p.sviClass].label : null;
    row.svi_rank = r2(p.sviRank);
    for (const k of S.svi.use) row[`svi_${k}`] = r2(p.sviParts?.[k]);
    if (S.svi.census) row.census_value = p.censusValue ?? null;
    row.dist_health_m = p.distHealth != null ? Math.round(p.distHealth) : null;
    row.dist_emergency_m = p.distEmergency != null ? Math.round(p.distEmergency) : null;
  }
  if (S.mh && p.hz) {
    for (const k of S.mh.use) row[`hz_${k}`] = S.mh.notes[k] ? null : r2(p.hz[k]);
    row.multi_hazard = r2(p.mhi);
    row.multi_hazard_class = p.mhi != null ? SCORE_CLASSES[scoreClass(p.mhi)].label : null;
    row.high_hazards = p.highHazards;
    if (p.risk != null) {
      row.combined_risk = r2(p.risk);
      row.combined_risk_class = SCORE_CLASSES[scoreClass(p.risk)].label;
    }
  }
  return row;
}

// ---- Summary tables -----------------------------------------------------------------------------

function parameterRows(S) {
  const rows = [];
  const add = (step, parameter, value) => rows.push({ step, parameter, value: Array.isArray(value) ? value.join('; ') : value });
  add('1 Area & data', 'area', S.areaLabel);
  add('1 Area & data', 'area_km2', r2(S.areaKm2));
  add('1 Area & data', 'bbox_w_s_e_n', S.ds.bbox.join(' '));
  add('1 Area & data', 'building_detail', S.loadOpts?.buildings);
  add('1 Area & data', 'layers_downloaded', ['facilities', 'waterways', 'roads', 'paths'].filter((k) => S.loadOpts?.[k]));
  const P = S.ds.popParams;
  add('2 Population', 'floor_area_per_person_m2', P.m2PerPerson);
  add('2 Population', 'storeys_if_unknown', P.defaultLevels);
  add('2 Population', 'untagged_buildings_are_homes', P.unknownResidential);
  add('2 Population', 'known_population', P.knownTotal || 'not set');
  add('2 Population', 'calibration_factor', r2(S.ds.popFactor));
  if (S.exposure) {
    add('4 Exposure', 'hazard_source', SOURCES[S.exposure.sourceKey].label);
    add('4 Exposure', 'within_m', S.exposure.dist);
    add('4 Exposure', 'use_elevation', S.exposure.elevation);
    if (S.exposure.elevation) add('4 Exposure', 'max_height_above_water_m', S.exposure.maxHeight);
  }
  if (S.risk) {
    const R = S.risk.params;
    add('5 Flood risk', 'flooding_from', SOURCES[R.source].label);
    add('5 Flood risk', 'max_distance_m', R.maxDist);
    for (const s of S.risk.scenarios) add('5 Flood risk', `water_level_${s.rp}yr_m`, s.level);
    for (const [k, v] of Object.entries(R.costs)) add('5 Flood risk', `cost_per_m2_${k}`, `${v} ${R.currency}`);
    add('5 Flood risk', 'contents_pct_of_structure', R.contentsPct);
    for (const [k, v] of Object.entries(S.finance)) add('5 Risk finance', k, v);
  }
  if (S.svi) {
    add('6 Social vulnerability', 'indicators', [...S.svi.use].map((k) => SVI_INDICATORS[k].label));
    add('6 Social vulnerability', 'classes', S.svi.mode);
    if (S.svi.census) add('6 Social vulnerability', 'census_field', `${S.svi.census.field} (higher = ${S.svi.census.higherIsWorse ? 'more' : 'less'} vulnerable)`);
    for (const [k, v] of Object.entries(S.shares)) add('6 Social vulnerability', `share_${k}_pct`, v);
  }
  if (S.mh) {
    for (const k of S.mh.use) add('7 Multi-hazard', `weight_${k}`, S.mh.weights[k]);
    add('7 Multi-hazard', 'river_flood_level_m', S.mh.settings.floodLevel);
    if (S.mh.use.has('coastal')) add('7 Multi-hazard', 'sea_level_plus_surge_m', S.mh.settings.coastLevel);
    if (S.mh.use.has('avalanche')) add('7 Multi-hazard', 'snow_line_m', S.mh.settings.snowLine);
    add('7 Multi-hazard', 'high_hazard_threshold', HIGH);
    add('7 Multi-hazard', 'background_noise_floor', NOISE_FLOOR);
    add('7 Multi-hazard', 'combined_with_social_vulnerability', S.mh.withSvi);
  }
  return rows;
}

function matrixRows(S) {
  return S.mh.matrix.map((m) => ({
    hazard: HAZARDS[m.key].label,
    mean_score: r2(m.mean),
    p90_score: r2(m.p90),
    likelihood_formula: `1 + floor(5 x ${r2(m.p90)})`,
    likelihood: m.likelihood,
    likelihood_label: LIKELIHOOD[m.likelihood - 1],
    homes_at_high_hazard: m.highHomes,
    residents_at_high_hazard: Math.round(m.exposedPop),
    share_of_residents_pct: r2(100 * m.exposedShare),
    impact_thresholds_pct: IMPACT_STEPS.map((t) => t * 100).join(' / '),
    impact_base: m.impactBase,
    health_education_emergency_at_high_hazard: m.criticalCount,
    impact_plus_one: m.critical,
    impact: m.impact,
    impact_label: IMPACT[m.impact - 1],
    score_l_x_i: m.score,
    rating: m.rating,
  }));
}

function hazardRows(S) {
  const homes = S.ds.buildings.filter((b) => b.pop > 0 && b.hz);
  return [...S.mh.use].map((k) => {
    if (S.mh.notes[k]) return { hazard: HAZARDS[k].label, status: S.mh.notes[k] };
    const hi = homes.filter((b) => (b.hz[k] ?? 0) >= HIGH);
    const m = S.mh.matrix.find((x) => x.key === k);
    return {
      hazard: HAZARDS[k].label, status: 'assessed', weight: S.mh.weights[k],
      homes_high: hi.length, residents_high: Math.round(hi.reduce((a, b) => a + b.pop, 0)),
      critical_facilities_high: S.ds.facilities.filter((f) => (f.hz?.[k] ?? 0) >= HIGH && CRITICAL_GROUPS.has(f.group)).length,
      rating: m.rating,
    };
  });
}

// ---- Readable summary ---------------------------------------------------------------------------

function summaryText(S) {
  const L = [];
  const h = (t) => L.push('', t, '-'.repeat(t.length));
  const ds = S.ds;
  const fmt = (n) => Math.round(n).toLocaleString('en');
  L.push('OpenHVRA: Hazard, Vulnerability & Risk Assessment from open data');
  L.push('================================================================');
  L.push(`Generated: ${S.generated}`);
  L.push('');
  L.push('BETA VERSION: OpenHVRA is under active development. New features are being added, and the methods');
  L.push('used to calculate hazard, vulnerability and risk may change as they are improved and validated.');
  L.push('Results may differ between versions, so keep the date above with any figures you share.');
  L.push(`App: https://gomalhunzai.github.io/openhvra/`);
  L.push(`Area: ${S.areaLabel}, ${r2(S.areaKm2)} km² (bbox ${ds.bbox.join(', ')})`);

  h('Contents of this package');
  L.push('README.txt                this summary');
  L.push('parameters.csv            every setting selected, by step');
  L.push('steps/step*.csv           detailed table for each step that was run (features it assessed)');
  L.push('buildings.csv             one row per building with every analysis value');
  L.push('facilities.csv            one row per facility with every analysis value');
  L.push('tables/*.csv              summary tables per step (incl. risk_matrix_calculation.csv)');
  L.push('layers/*.geojson          map layers with the same values (open in QGIS/ArcGIS)');

  h('1. Data');
  const s = ds.summary();
  L.push(`${fmt(s.buildings)} buildings, ${fmt(s.facilities)} facilities, roads ${(s.len.road / 1000).toFixed(2)} km, waterways ${(s.len.water / 1000).toFixed(2)} km.`);
  L.push(`Building detail: ${S.loadOpts?.buildings ?? 'n/a'}${S.loadOpts?.buildings === 'light' ? ' (areas estimated from bounding boxes)' : ''}.`);

  h('2. Population');
  L.push(`Estimated residents: ${fmt(s.pop)} (floor area per person ${ds.popParams.m2PerPerson} m², storeys if unknown ${ds.popParams.defaultLevels}${ds.popFactor !== 1 ? `, calibrated ×${ds.popFactor.toFixed(2)}` : ''}).`);
  for (const [k, label] of Object.entries(BUILDING_CLASSES)) if (s.classes[k]) L.push(`  ${label}: ${fmt(s.classes[k].count)} buildings, ${fmt(s.classes[k].pop)} residents`);

  if (S.exposure) {
    const E = S.exposure;
    h('4. Exposure by distance');
    L.push(`Source: ${SOURCES[E.sourceKey].label}; within ${E.dist} m${E.elevation ? ` and ≤ ${E.maxHeight} m above the water` : ''}.`);
    L.push(`Exposed: ${fmt(E.buildings)} buildings, ${fmt(E.pop)} residents, ${Object.values(E.groups).reduce((a, b) => a + b, 0)} facilities.`);
    if (E.elevation) {
      L.push(`Steep bank (erosion risk): ${fmt(E.bank.buildings)} buildings, ${fmt(E.bank.pop)} residents.`);
      L.push(`Higher ground (not exposed): ${fmt(E.high.buildings)} buildings, ${fmt(E.high.pop)} residents.`);
    }
  } else L.push('', '4. Exposure by distance: not run.');

  if (S.risk) {
    const R = S.risk;
    const cur = R.params.currency;
    h('5. Flood risk & risk finance');
    L.push(`Total building value: ${cur} ${fmt(R.totalValue)}. Average annual loss: ${cur} ${fmt(R.aal)} (${((100 * R.aal) / (R.totalValue || 1)).toFixed(2)}%). People affected per year: ${fmt(R.annualPop)}.`);
    for (const sc of R.scenarios) L.push(`  ${sc.rp}-yr (${sc.level} m): ${fmt(sc.buildings)} buildings, ${fmt(sc.pop)} people, ${sc.facilities.length} critical facilities, loss ${cur} ${fmt(sc.loss)}`);
    for (const l of S.layers) L.push(`  ${l.name} (${l.rp}, ${l.instrument}): expected ${cur} ${fmt(l.eal)}/yr, cost ${l.cost == null ? '—' : `${cur} ${fmt(l.cost)}/yr`}`);
  } else L.push('', '5. Flood risk: not run.');

  if (S.svi) {
    h('6. Social vulnerability');
    const sv = sviSummary(ds);
    L.push(`Indicators: ${[...S.svi.use].map((k) => SVI_INDICATORS[k].label).join(', ')}. Classes: ${S.svi.mode}.`);
    SVI_CLASSES.forEach((c, i) => L.push(`  ${c.label}: ${fmt(sv.classes[i].buildings)} homes, ${fmt(sv.classes[i].pop)} residents`));
    const g = groupCounts(ds.popTotal, S.shares);
    for (const [k, grp] of Object.entries(GROUPS)) L.push(`  ${grp.label}: ${S.shares[k]}% ≈ ${fmt(g[k])} people`);
  } else L.push('', '6. Social vulnerability: not run.');

  if (S.mh) {
    h('7. Multi-hazard risk');
    if (S.mh.ctx.quakes && S.mh.use.has('earthquake')) {
      const q = S.mh.ctx.quakes;
      L.push(`Earthquake: ${q.n150} M5+ within 150 km since 1973 (~1 every ${q.rate > 0 ? (1 / q.rate).toFixed(1) : '∞'} yr); hazard score ${q.score.toFixed(2)}.`);
    }
    for (const r of hazardRows(S)) L.push(`  ${r.hazard}: ${r.status === 'assessed' ? `${fmt(r.homes_high)} homes / ${fmt(r.residents_high)} residents at high hazard, ${r.critical_facilities_high} critical facilities, rating ${r.rating}` : r.status}`);
    L.push('', 'Risk matrix calculation:');
    for (const m of S.mh.matrix) {
      L.push(`  ${HAZARDS[m.key].label}: likelihood = 1 + floor(5 × p90 ${m.p90.toFixed(2)}) = ${m.likelihood} (${LIKELIHOOD[m.likelihood - 1]}); ` +
        `${(100 * m.exposedShare).toFixed(1)}% residents at high hazard → impact base ${m.impactBase}${m.critical ? ` +1 (${m.criticalCount} health/education/emergency facilities)` : ''} = ${m.impact} (${IMPACT[m.impact - 1]}); ` +
        `L × I = ${m.score} → ${m.rating}`);
    }
    L.push(`  Rules: high hazard = score ≥ ${HIGH}; impact steps at ${IMPACT_STEPS.map((t) => `${t * 100}%`).join(', ')} of residents; rating 1–4 Low, 5–9 Medium, 10–16 High, 20–25 Extreme.`);
    L.push(`Multi-hazard index = 1 − Π(1 − weight × rescaled score); scores below ${NOISE_FLOOR} treated as background.`);
    if (S.mh.withSvi) L.push('Combined risk = √(multi-hazard index × social vulnerability), as in INFORM.');
  } else L.push('', '7. Multi-hazard: not run.');

  h('Important');
  L.push('These are screening estimates from open data (OpenStreetMap, ~30 m elevation, USGS, World Bank).');
  L.push('They show where to look first; confirm with official hazard maps, local data and field checks.');
  L.push('Default values (water levels, costs, shares) are placeholders unless you changed them: see parameters.csv.');
  h('Credits');
  L.push('Data © OpenStreetMap contributors (ODbL), Overpass API, AWS Terrain Tiles, USGS, World Bank, Nominatim.');
  L.push('OpenHVRA by Gomal Amin — https://www.openstreetmap.org/user/Gomal%20Amin');
  return L.join('\n');
}

// ---- GeoJSON layers -----------------------------------------------------------------------------

function roundGeom(g) {
  const walk = (c) => (typeof c[0] === 'number' ? [r6(c[0]), r6(c[1])] : c.map(walk));
  return { type: g.type, coordinates: walk(g.coordinates) };
}

function fc(features) {
  return JSON.stringify({ type: 'FeatureCollection', features });
}

// ---- Package --------------------------------------------------------------------------------------

// ---- Per-step detail ------------------------------------------------------------------------------

// Identity and building/facility attributes shared by every step table.
const BASE_COLS = new Set(['osm_id', 'osm_url', 'lon', 'lat', 'name', 'class', 'class_label', 'type', 'material', 'storeys',
  'storeys_from_osm', 'footprint_m2', 'footprint_estimated', 'floor_area_m2', 'residents', 'group', 'group_label', 'critical']);

export const STEPS = [
  { key: 'population', label: 'Population (step 2)', file: 'step2_population.csv', ran: (S) => !!S.ds },
  { key: 'exposure', label: 'Exposure by distance (step 4)', file: 'step4_exposure.csv', ran: (S) => !!S.exposure },
  { key: 'flood', label: 'Flood risk (step 5)', file: 'step5_flood_risk.csv', ran: (S) => !!S.risk },
  { key: 'svi', label: 'Social vulnerability (step 6)', file: 'step6_social_vulnerability.csv', ran: (S) => !!S.svi },
  { key: 'mh', label: 'Multi-hazard risk (step 7)', file: 'step7_multi_hazard.csv', ran: (S) => !!S.mh },
];

const STEP_COLS = {
  population: () => false,
  exposure: (c) => c.startsWith('exp_'),
  flood: (c) => c.startsWith('flood_') || c === 'slope_deg',
  svi: (c) => c.startsWith('svi') || c === 'census_value' || c.startsWith('dist_'),
  mh: (c) => c.startsWith('hz_') || c.startsWith('multi_hazard') || c === 'high_hazards' || c.startsWith('combined_risk'),
};

// Rows for one step: the features that step assessed, with identity columns
// plus that step's values (and a few step-specific extras).
export function stepRows(S, key) {
  const exp = exposureIndex(S);
  const ds = S.ds;
  const pick = (row) => Object.fromEntries(Object.entries(row).filter(([c]) => BASE_COLS.has(c) || STEP_COLS[key](c)));
  let feats;
  if (key === 'population') feats = ds.buildings;
  else if (key === 'exposure') feats = ds.points.filter((p) => exp.has(p));
  else if (key === 'flood') feats = ds.points.filter((p) => p.hand != null);
  else if (key === 'svi') feats = ds.buildings.filter((b) => b.pop > 0 && b.svi != null);
  else feats = ds.points.filter((p) => p.hz);
  return feats.map((p) => {
    const row = pick(featureRow(p, S, exp));
    if (key === 'population' && p.kind === 'building') {
      row.residential = p.pop > 0;
      Object.assign(row, Object.fromEntries(Object.entries(groupCounts(p.pop, S.shares)).map(([g, v]) => [`est_${g}`, r2(v)])));
    }
    if (key === 'svi') {
      Object.assign(row, Object.fromEntries(Object.entries(groupCounts(p.pop, S.shares)).map(([g, v]) => [`est_${g}`, r2(v)])));
      if (S.risk && p.depths) {
        const sc = S.risk.scenarios[S.riskScenario];
        row[`flood_depth_${sc.rp}yr_m`] = r2(p.depths[S.riskScenario]);
      }
      if (S.mh && p.hz) {
        row.multi_hazard = r2(p.mhi);
        if (p.risk != null) row.combined_risk = r2(p.risk);
      }
    }
    return row;
  });
}

export function stepCSV(S, key) {
  return toCSV(stepRows(S, key));
}

// Light GeoJSON: points with the step's values.
export function stepGeoJSON(S, key) {
  return fc(stepRows(S, key).map((row) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [row.lon, row.lat] }, properties: row })));
}

export function buildingsCSV(S) {
  const exp = exposureIndex(S);
  return toCSV(S.ds.buildings.map((b) => featureRow(b, S, exp)));
}

export function facilitiesCSV(S) {
  const exp = exposureIndex(S);
  return toCSV(S.ds.facilities.map((f) => featureRow(f, S, exp)));
}

export function matrixCSV(S) {
  return S.mh ? toCSV(matrixRows(S)) : '';
}

// Returns a Uint8Array ZIP.
export async function buildPackage(S) {
  const { zipSync, strToU8 } = await import(FFLATE);
  const ds = S.ds;
  const exp = exposureIndex(S);
  const files = {};
  const put = (name, text) => {
    if (text) files[name] = strToU8(text);
  };
  put('README.txt', summaryText(S));
  for (const st of STEPS) if (st.ran(S)) put(`steps/${st.file}`, stepCSV(S, st.key));
  put('parameters.csv', toCSV(parameterRows(S)));
  const bRows = ds.buildings.map((b) => featureRow(b, S, exp));
  const fRows = ds.facilities.map((f) => featureRow(f, S, exp));
  put('buildings.csv', toCSV(bRows));
  put('facilities.csv', toCSV(fRows));

  const s = ds.summary();
  put('tables/population_by_class.csv', toCSV(Object.entries(s.classes).map(([k, c]) => ({ class: BUILDING_CLASSES[k], buildings: c.count, residents: Math.round(c.pop), floor_area_m2: Math.round(c.area) }))));
  put('tables/facilities_by_group.csv', toCSV(Object.entries(FACILITY_GROUPS).map(([k, g]) => ({ group: g.label, count: s.groups[k] ?? 0, critical: CRITICAL_GROUPS.has(k) }))));
  if (S.exposure) {
    const E = S.exposure;
    const rows = [{ class: E.elevation ? 'flood-exposed' : 'within distance', buildings: E.buildings, residents: Math.round(E.pop), facilities: Object.values(E.groups).reduce((a, b) => a + b, 0) }];
    if (E.elevation) {
      rows.push({ class: 'steep bank (erosion risk)', buildings: E.bank.buildings, residents: Math.round(E.bank.pop), facilities: E.bank.facilities });
      rows.push({ class: 'higher ground (not exposed)', buildings: E.high.buildings, residents: Math.round(E.high.pop), facilities: E.high.facilities });
    }
    put('tables/exposure_summary.csv', toCSV(rows));
  }
  if (S.risk) {
    const R = S.risk;
    put('tables/flood_scenarios.csv', toCSV(R.scenarios.map((sc) => ({
      return_period_yr: sc.rp, annual_probability: r2(1 / sc.rp), water_level_m: sc.level, buildings_flooded: sc.buildings,
      people_affected: Math.round(sc.pop), critical_facilities: sc.facilities.length, loss: Math.round(sc.loss), currency: R.params.currency,
    }))));
    put('tables/flood_risk_summary.csv', toCSV([{ total_value: Math.round(R.totalValue), average_annual_loss: Math.round(R.aal), aal_pct_of_value: r2((100 * R.aal) / (R.totalValue || 1)), people_affected_per_year: Math.round(R.annualPop), currency: R.params.currency }]));
    put('tables/finance_layers.csv', toCSV(S.layers.map((l) => ({
      layer: l.name, instrument: l.instrument, return_periods: l.rp, covers_from: Math.round(l.from), covers_to: Number.isFinite(l.to) ? Math.round(l.to) : 'unlimited',
      expected_annual_loss: Math.round(l.eal), indicative_annual_cost: l.cost == null ? null : Math.round(l.cost), cost_basis: l.costNote, currency: R.params.currency,
    }))));
  }
  if (S.svi) {
    const sv = sviSummary(ds);
    put('tables/svi_classes.csv', toCSV(SVI_CLASSES.map((c, i) => ({ class: c.label, homes: sv.classes[i].buildings, residents: Math.round(sv.classes[i].pop) }))));
    put('tables/svi_indicator_means.csv', toCSV(Object.entries(sv.means).map(([k, v]) => ({ indicator: SVI_INDICATORS[k].label, mean_score: r2(v), scoring: SVI_INDICATORS[k].note }))));
    const g = groupCounts(ds.popTotal, S.shares);
    put('tables/vulnerable_groups.csv', toCSV(Object.entries(GROUPS).map(([k, grp]) => ({
      group: grp.label, share_pct: S.shares[k], people_in_area: Math.round(g[k]),
      ...(S.risk ? { people_flooded_selected_scenario: Math.round((S.risk.scenarios[S.riskScenario].pop * S.shares[k]) / 100), scenario: `${S.risk.scenarios[S.riskScenario].rp}-yr` } : {}),
    }))));
  }
  if (S.mh) {
    put('tables/hazard_summary.csv', toCSV(hazardRows(S)));
    put('tables/risk_matrix_calculation.csv', toCSV(matrixRows(S)));
    const q = S.mh.ctx.quakes;
    if (q && S.mh.use.has('earthquake')) {
      put('tables/earthquakes.csv', toCSV([
        ...(q.maxNear ? [{ list: 'largest within 100 km', ...q.maxNear }] : []),
        ...q.largest.map((e) => ({ list: 'largest within 300 km', ...e })),
      ].map((e) => ({ list: e.list, magnitude: e.mag, year: e.year, place: e.place, depth_km: r1(e.depth), distance_km: Math.round(e.dist) }))));
    }
  }

  // Map layers: same values as the tables.
  if (S.aoi) put('layers/area.geojson', fc([{ type: 'Feature', properties: { name: S.areaLabel }, geometry: roundGeom({ type: 'MultiPolygon', coordinates: S.aoi.polygons }) }]));
  put('layers/buildings.geojson', fc(ds.buildings.map((b, i) => ({ type: 'Feature', geometry: roundGeom(b.feature.geometry), properties: bRows[i] }))));
  put('layers/facilities.geojson', fc(ds.facilities.map((f, i) => ({ type: 'Feature', geometry: roundGeom(f.feature.geometry), properties: fRows[i] }))));
  const line = (l) => ({ type: 'Feature', geometry: roundGeom(l.feature.geometry), properties: { osm_id: l.osm_id, type: l.type, class: l.cls, name: l.name, length_m: Math.round(l.length), bridge: l.bridge ?? null } });
  put('layers/roads.geojson', fc(ds.lines.filter((l) => l.kind === 'road').map(line)));
  put('layers/waterways.geojson', fc(ds.lines.filter((l) => l.kind === 'water').map(line)));
  if (S.mh?.ctx.lakes?.length) {
    put('layers/glacial_lakes.geojson', fc(S.mh.ctx.lakes.map((l) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r6(l.lon), r6(l.lat)] }, properties: { name: l.name, area_m2: Math.round(l.area), elevation_m: Math.round(l.elev), source: l.source } }))));
  }
  return zipSync(files, { level: 6 });
}
