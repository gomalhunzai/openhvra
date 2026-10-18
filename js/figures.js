// Publication charts for each analysis step, built from the export snapshot.

import { barChart, exceedanceChart, matrixChart, fmtInt, fmtMoney, SERIES } from './pubcharts.js';
import { BUILDING_CLASSES, FACILITY_GROUPS } from './osm.js';
import { SOURCES } from './analysis.js';
import { SVI_CLASSES, SVI_INDICATORS, GROUPS, groupCounts, sviSummary } from './social.js';
import { HAZARDS, HIGH, LIKELIHOOD, IMPACT, rating, SCORE_CLASSES, scoreClass } from './hazards.js';

const OSM = 'Buildings and facilities © OpenStreetMap contributors';
const ELEV = 'elevation: AWS Terrain Tiles';

function subtitle(S, extra = '') {
  return `${S.areaLabel}${extra ? ` · ${extra}` : ''} · ${S.dateLabel}`;
}

// Returns [{ id, title, svg }] for one step ('population' | 'exposure' | 'flood' | 'svi' | 'mh').
export function figuresFor(S, step) {
  const ds = S.ds;
  const out = [];
  const add = (id, svg) => out.push({ id, svg, title: svg.match(/font-weight="700">([^<]*)</)?.[1] ?? id });

  if (step === 'population') {
    const s = ds.summary();
    const rows = Object.entries(BUILDING_CLASSES).filter(([k]) => s.classes[k]).map(([k, label]) => ({ label, value: s.classes[k].pop }));
    add('population-by-class', barChart({
      title: 'Estimated residents by building class', subtitle: subtitle(S, `${fmtInt(s.pop)} residents`), rows,
      axisLabel: 'Estimated residents', source: `${OSM}; residents modelled from floor area (${ds.popParams.m2PerPerson} m² per person)`,
    }));
    const frows = Object.entries(FACILITY_GROUPS).filter(([k]) => s.groups[k]).map(([k, g]) => ({ label: g.label, value: s.groups[k], color: g.color }));
    if (frows.length) add('facilities-by-group', barChart({ title: 'Facilities by type', subtitle: subtitle(S, `${fmtInt(s.facilities)} facilities`), rows: frows, axisLabel: 'Number of facilities', source: OSM }));
  }

  if (step === 'exposure' && S.exposure) {
    const E = S.exposure;
    const src = SOURCES[E.sourceKey].label.toLowerCase();
    const rows = E.elevation
      ? [
        { label: `Flood-exposed (≤ ${E.maxHeight} m above)`, value: E.pop, color: '#e03131' },
        { label: 'Steep bank (erosion risk)', value: E.bank.pop, color: '#f08c00' },
        { label: 'Higher ground', value: E.high.pop, color: '#adb5bd' },
      ]
      : [{ label: `Within ${E.dist} m`, value: E.pop, color: '#e03131' }];
    add('exposure-residents', barChart({
      title: `Residents within ${E.dist} m of ${src}`, subtitle: subtitle(S, E.elevation ? 'split by height above the water' : ''), rows,
      axisLabel: 'Estimated residents', source: `${OSM}${E.elevation ? `; ${ELEV}` : ''}`,
    }));
    const grows = Object.entries(FACILITY_GROUPS).filter(([k]) => E.groups[k]).map(([k, g]) => ({ label: g.label, value: E.groups[k], color: g.color }));
    if (grows.length) add('exposure-facilities', barChart({ title: `Exposed facilities by type (within ${E.dist} m of ${src})`, subtitle: subtitle(S), rows: grows, axisLabel: 'Number of facilities', source: OSM }));
  }

  if (step === 'flood' && S.risk) {
    const R = S.risk;
    const cur = R.params.currency;
    const money = fmtMoney(cur);
    add('flood-loss-exceedance', exceedanceChart({
      title: 'Flood loss-exceedance curve', subtitle: subtitle(S, `average annual loss ${money(R.aal)}`),
      points: R.curve.map((c) => ({ rp: c.rp, value: c.loss })), format: money, yLabel: `Loss (${cur})`,
      source: `${OSM}; ${ELEV}; JRC depth-damage curves (Asia)`,
    }));
    add('flood-people-by-scenario', barChart({
      title: 'People affected by flood scenario', subtitle: subtitle(S),
      rows: R.scenarios.map((s) => ({ label: `${s.rp}-year (${s.level} m)`, value: s.pop })), axisLabel: 'Estimated people in flooded buildings',
      source: `${OSM}; ${ELEV}`,
    }));
    add('flood-loss-by-scenario', barChart({
      title: 'Building loss by flood scenario', subtitle: subtitle(S),
      rows: R.scenarios.map((s) => ({ label: `${s.rp}-year (${s.level} m)`, value: s.loss })), format: money, axisLabel: `Loss (${cur})`,
      source: `${OSM}; ${ELEV}; replacement costs as set by user`,
    }));
    if (S.layers) {
      add('finance-layers', barChart({
        title: 'Expected annual loss by risk-finance layer', subtitle: subtitle(S),
        rows: S.layers.map((l) => ({ label: `${l.name} (${l.rp})`, value: l.eal })), format: money, axisLabel: `Expected annual loss (${cur})`,
        source: 'Layers split the loss-exceedance curve by return period',
      }));
    }
  }

  if (step === 'svi' && S.svi) {
    const sv = sviSummary(ds);
    add('svi-classes', barChart({
      title: 'Residents by social vulnerability class', subtitle: subtitle(S, S.svi.mode === 'relative' ? 'classes relative to this area' : 'absolute classes'),
      rows: SVI_CLASSES.map((c, i) => ({ label: c.label, value: sv.classes[i].pop, color: c.color })), axisLabel: 'Estimated residents',
      source: `${OSM}; social vulnerability index from OSM proxies`,
    }));
    const g = groupCounts(ds.popTotal, S.shares);
    add('vulnerable-groups', barChart({
      title: 'Estimated vulnerable groups', subtitle: subtitle(S),
      rows: Object.entries(GROUPS).map(([k, grp]) => ({ label: `${grp.label} (${S.shares[k]}%)`, value: g[k] })), axisLabel: 'Estimated people',
      source: 'Shares: World Bank WDI or user input; disability: WHO global estimate',
    }));
    add('svi-indicators', barChart({
      title: 'Average indicator scores (0 = least, 1 = most vulnerable)', subtitle: subtitle(S, 'weighted by residents'),
      rows: Object.entries(sv.means).map(([k, v]) => ({ label: SVI_INDICATORS[k].label, value: v })), format: (v) => v.toFixed(2), max: 1,
      axisLabel: 'Mean score', source: OSM,
    }));
  }

  if (step === 'mh' && S.mh) {
    const mh = S.mh;
    add('risk-matrix', matrixChart({
      title: 'Multi-hazard risk matrix', subtitle: subtitle(S),
      items: mh.matrix.map((m) => ({ label: HAZARDS[m.key].short, likelihood: m.likelihood, impact: m.impact })),
      likelihoodLabels: LIKELIHOOD, impactLabels: IMPACT, rating,
      source: `${OSM}; ${ELEV}; USGS earthquake catalogue`,
    }));
    const homes = ds.buildings.filter((b) => b.pop > 0 && b.hz);
    add('residents-high-hazard', barChart({
      title: `Residents at high hazard (score ≥ ${HIGH})`, subtitle: subtitle(S),
      rows: mh.keys.map((k) => ({ label: HAZARDS[k].label, value: homes.filter((b) => (b.hz[k] ?? 0) >= HIGH).reduce((a, b) => a + b.pop, 0), color: '#ad2b2b' })),
      axisLabel: 'Estimated residents', source: `${OSM}; ${ELEV}`,
    }));
    const byClass = (f) => SCORE_CLASSES.map((c, i) => ({ label: c.label, color: c.color, value: homes.filter((b) => f(b) != null && scoreClass(f(b)) === i).reduce((a, b) => a + b.pop, 0) }));
    add('multi-hazard-classes', barChart({ title: 'Residents by multi-hazard class', subtitle: subtitle(S), rows: byClass((b) => b.mhi), axisLabel: 'Estimated residents', source: `${OSM}; ${ELEV}` }));
    if (mh.withSvi) add('combined-risk-classes', barChart({ title: 'Residents by combined risk class (hazard × social vulnerability)', subtitle: subtitle(S), rows: byClass((b) => b.risk), axisLabel: 'Estimated residents', source: `${OSM}; ${ELEV}` }));
  }
  return out;
}

export const FIGURE_STEPS = ['population', 'exposure', 'flood', 'svi', 'mh'];
export { SERIES };
