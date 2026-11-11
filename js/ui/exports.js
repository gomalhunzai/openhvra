// Step 8 and per-step exports: downloads, map and chart layouts, report package.

import { FACILITY_GROUPS } from '../osm.js';
import { SOURCES } from '../analysis.js';
import { ringBBox, bboxAreaKm2 } from '../spatial.js';
import { financeLayers, expectedAnnual } from '../risk.js';
import { VERSION } from '../version.js';
import { figuresFor } from '../figures.js';
import { elevationSource, elevationCredit, ELEVATION_SOURCES } from '../elevation.js';
import { svgToPng } from '../pubcharts.js';
import { renderMapLayout } from '../mapexport.js';
import { buildPackage, buildingsCSV, facilitiesCSV, matrixCSV, STEPS, stepCSV } from '../report.js';
import { SVI_CLASSES, sviSummary } from '../social.js';
import { HAZARDS, HIGH, SCORE_CLASSES } from '../hazards.js';
import { $, DEPTH_CLASSES, state } from './shared.js';
import { compact, escapeHtml, fmt } from './format.js';
import { map } from './map.js';
import { aoiArea } from './area.js';
import { financeParams } from './flood.js';
import { shares } from './social.js';
import { mhFeatures, mhValue } from './multihazard.js';
import { saved2D } from './view3d.js';

// ---- Downloads (light: points, 6-decimal coordinates, essential fields) ------------------------

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r1 = (v) => Math.round(v * 10) / 10;
function baseProps(p) {
  return p.kind === 'building'
    ? { osm_id: p.osm_id, kind: 'building', class: p.cls, type: p.type, name: p.name, storeys: p.floors, footprint_m2: Math.round(p.footprint), residents: r1(p.pop), ...(state.sviDone && p.svi != null ? { svi: Math.round(p.svi * 100) / 100 } : {}) }
    : { osm_id: p.osm_id, kind: 'facility', group: p.group, type: p.type, name: p.name };
}
export function pointsGeoJSON(rows) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: rows.map(({ p, props }) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: p.feature.center.map(r6) },
      properties: { ...baseProps(p), ...props },
    })),
  });
}
function toCSV(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
}
function exposureRows() {
  const res = state.exposure;
  const list = res.elevation ? res.all : res.hits;
  return list.map(({ p, d, height, bank, ex }) => ({
    p,
    props: {
      distance_m: Math.round(d),
      ...(res.elevation ? { height_above_water_m: height != null ? r1(height) : null, bank_angle_deg: bank != null ? Math.round(bank) : null, exposure: ex } : {}),
    },
  }));
}
function riskRows() {
  const R = state.risk;
  return state.dataset.points.filter((p) => p.hand != null).map((p) => {
    const props = { hand_m: r1(p.hand) };
    R.scenarios.forEach((s, i) => (props[`depth_${s.rp}yr_m`] = r1(p.depths[i])));
    if (p.kind === 'building') {
      props.value = Math.round(p.value);
      R.scenarios.forEach((s, i) => (props[`loss_${s.rp}yr`] = Math.round(p.losses[i])));
      props.avg_annual_loss = Math.round(expectedAnnual(R.scenarios.map((s, i) => ({ rp: s.rp, v: p.losses[i] }))));
    }
    return { p, props };
  });
}
export function csvOf(rows) {
  return toCSV(rows.map(({ p, props }) => ({
    ...baseProps(p), ...props, lon: r6(p.feature.center[0]), lat: r6(p.feature.center[1]), osm_url: `https://www.openstreetmap.org/${p.osm_id}`,
  })));
}
$('dl-geojson').addEventListener('click', () => {
  const { sourceKey, dist } = state.exposure;
  download(`osm-exposure_${sourceKey}_${dist}m.geojson`, pointsGeoJSON(exposureRows()), 'application/geo+json');
});
$('dl-csv').addEventListener('click', () => {
  const { sourceKey, dist } = state.exposure;
  download(`osm-exposure_${sourceKey}_${dist}m.csv`, csvOf(exposureRows()), 'text/csv');
});
$('dl-risk-csv').addEventListener('click', () => download('osm-flood-risk.csv', csvOf(riskRows()), 'text/csv'));
$('dl-risk-geojson').addEventListener('click', () => download('osm-flood-risk.geojson', pointsGeoJSON(riskRows()), 'application/geo+json'));
// ---- Map and chart exports (per step) -----------------------------------------------------------

const PROBE_LAYERS = ['probe-fill', 'probe-line', 'probe-hits', 'probe-links'];
const COLOUR_LAYERS = { exposure: ['buffer', 'exposed-fill', 'exposed-pt'], depth: ['risk-fill', 'risk-pt'], svi: ['svi-fill', 'svi-pt'], mh: ['mh-fill', 'mh-pt'] };
const others = (keep) => Object.entries(COLOUR_LAYERS).filter(([k]) => k !== keep).flatMap(([, ids]) => ids);
const ORIENT_LEGEND = [
  { label: 'Waterway', color: '#1c7ed6', kind: 'line' },
  { label: 'Major road', color: '#f59f00', kind: 'line' },
  { label: 'Extent of downloaded data', color: '#495057', kind: 'dash' },
];
// Facility dots use categorical colours that would clash with the thematic
// colour scales, so they only appear on the overview map.
const NO_FACILITIES = ['facilities'];
// Glaciers, lakes and outflow paths appear only on the GLOF map (user marks never).
const CRYO = ['cryo-glacier-fill', 'cryo-glacier-line', 'cryo-paths-other', 'cryo-paths', 'cryo-lakes'];
const MARKS = ['cryo-marks-line', 'cryo-marks-pt'];
const credits = () => `Data © OpenStreetMap contributors (ODbL); elevation: ${elevationCredit(state.dem?.dem)}; USGS; World Bank`;
// Map layout settings for a step's map. `view` picks the multi-hazard view.
function mapSpec(step, view) {
  const S = snapshot();
  const [w, s, e, n] = state.dataset.bbox;
  const base = {
    bounds: [[w, s], [e, n]], credits: credits(),
    subtitle: `${S.areaLabel} · ${S.areaKm2.toFixed(2)} km² · ${S.dateLabel}`,
    legend: [...(state.loadedAoi ? [{ label: 'Analysed area', color: '#7048e8', kind: 'line' }] : []), ...ORIENT_LEGEND],
  };
  const fmtN = (v) => fmt(Math.round(v));
  if (step === 'population') {
    const sum = state.dataset.summary();
    return { ...base, file: 'map-buildings-facilities', title: 'Buildings and facilities', show: ['facilities'], hide: [...PROBE_LAYERS, ...CRYO, ...MARKS, ...others(null)],
      legend: [{ label: 'Building', color: '#5c6b7a', kind: 'fill' }, ...base.legend, ...Object.values(FACILITY_GROUPS).map((g) => ({ label: g.label, color: g.color, kind: 'dot' }))], stats: [['estimated residents', fmtN(sum.pop)], ['buildings', fmtN(sum.buildings)], ['facilities', fmtN(sum.facilities)]] };
  }
  if (step === 'exposure') {
    const E = state.exposure;
    return { ...base, file: 'map-exposure', title: `Exposure within ${E.dist} m of ${SOURCES[E.sourceKey].label.toLowerCase()}`,
      show: COLOUR_LAYERS.exposure, hide: [...PROBE_LAYERS, ...CRYO, ...MARKS, ...NO_FACILITIES, ...others('exposure')],
      legend: [{ label: E.elevation ? `Flood-exposed (≤ ${E.maxHeight} m above water)` : 'Within distance', color: '#e03131', kind: 'fill' },
        ...(E.elevation ? [{ label: 'Steep bank (erosion risk)', color: '#f08c00', kind: 'fill' }] : []),
        { label: 'Exposed facility', color: '#e03131', kind: 'ring' }, { label: `${E.dist} m buffer`, color: '#fcc2c2', kind: 'fill' }, ...base.legend],
      stats: [[`residents ${E.elevation ? 'flood-exposed' : 'within distance'}`, fmtN(E.pop)], ['buildings', fmtN(E.buildings)], ...(E.elevation ? [['residents on steep banks', fmtN(E.bank.pop)]] : [])] };
  }
  if (step === 'flood') {
    const R = state.risk;
    const sc = R.scenarios[state.riskScenario];
    return { ...base, file: `map-flood-depth-${sc.rp}yr`, title: `Flood depth: ${sc.rp}-year flood (${sc.level} m above the channel)`,
      show: COLOUR_LAYERS.depth, hide: [...PROBE_LAYERS, ...CRYO, ...MARKS, ...NO_FACILITIES, ...others('depth')], legendTitle: 'Flood depth', ramp: DEPTH_CLASSES.map((c) => ({ label: c.label, color: c.color })),
      stats: [['buildings flooded', fmtN(sc.buildings)], ['people affected', fmtN(sc.pop)], [`loss (${R.params.currency})`, compact(sc.loss)], [`average annual loss (${R.params.currency})`, compact(R.aal)]] };
  }
  if (step === 'svi') {
    const sv = sviSummary(state.dataset);
    return { ...base, file: 'map-social-vulnerability', title: 'Social vulnerability of homes',
      show: COLOUR_LAYERS.svi, hide: [...PROBE_LAYERS, ...CRYO, ...MARKS, ...NO_FACILITIES, ...others('svi')], legendTitle: `Social vulnerability (${state.sviDone.mode})`, ramp: SVI_CLASSES.map((c) => ({ label: c.label, color: c.color })),
      stats: [['residents in high or very high vulnerability homes', fmtN(sv.classes[3].pop + sv.classes[4].pop)], ['homes scored', fmtN(sv.classes.reduce((a, c) => a + c.buildings, 0))]] };
  }
  if (step === 'mh') {
    const k = view ?? state.mh.show;
    const label = k === 'mhi' ? 'Multi-hazard index' : k === 'risk' ? 'Combined risk (hazard × social vulnerability)' : `${HAZARDS[k].label} hazard`;
    const homes = state.dataset.buildings.filter((b) => b.pop > 0 && b.hz);
    const high = homes.filter((b) => (mhValue(b, k) ?? 0) >= HIGH).reduce((a, b) => a + b.pop, 0);
    const glof = k === 'glof';
    const glofLegend = glof ? [
      { label: 'Glacier', color: '#a5d8ff', kind: 'fill' },
      { label: 'Glacial lake used (drains through area)', color: '#1971c2', kind: 'dot' },
      { label: 'Glacial lake not used (drains elsewhere)', color: '#74c0fc', kind: 'dot' },
      { label: 'Outflow path reaching the area', color: '#7048e8', kind: 'line' },
      { label: 'Outflow path draining elsewhere', color: '#868e96', kind: 'dash' },
    ] : [];
    // The GLOF map is framed to include the lakes and their paths.
    let bounds = base.bounds;
    if (glof && state.mh.ctx.lakes?.length) {
      const used = state.mh.ctx.lakes.filter((l) => l.reaches);
      const pts = [...used.flatMap((l) => [[l.lon, l.lat], ...l.path]), base.bounds[0], base.bounds[1]];
      const [bw, bs, be, bn] = ringBBox(pts);
      bounds = [[bw, bs], [be, bn]];
    }
    return { ...base, bounds, legend: [...glofLegend, ...base.legend], file: `map-${k === 'mhi' ? 'multi-hazard' : k === 'risk' ? 'combined-risk' : `hazard-${k}`}`, title: label,
      show: glof ? [...COLOUR_LAYERS.mh, ...CRYO] : COLOUR_LAYERS.mh, hide: [...PROBE_LAYERS, ...(glof ? [] : CRYO), ...MARKS, ...NO_FACILITIES, ...others('mh')], data: { mh: mhFeatures(k) }, legendTitle: label, ramp: SCORE_CLASSES.map((c) => ({ label: c.label, color: c.color })),
      stats: [[`residents at score ≥ ${HIGH}`, fmtN(high)], ['residents assessed', fmtN(homes.reduce((a, b) => a + b.pop, 0))]] };
  }
  return null;
}
async function exportMap(step, view, statusEl) {
  const spec = mapSpec(step, view);
  spec.hide = [...(spec.hide ?? []), 'b3d', 'hillshade'];
  if (state.is3d) spec.paint = saved2D;
  if (statusEl) statusEl.textContent = 'Rendering the map at 300 DPI…';
  const blob = await renderMapLayout(map, spec);
  return { name: `${spec.file}.png`, blob };
}
function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// Export controls appended to a step's results.
export function exportsBlock(step) {
  const figs = figuresFor(snapshot(), step);
  return `<div class="exports" data-step="${step}">
    <div class="row"><button type="button" class="btn" data-map="${step}">Map (PNG, 300 DPI)</button></div>
    <p class="note export-status"></p>
    ${figs.length ? `<details class="charts"><summary>Charts (${figs.length}): preview and download</summary>
      ${figs.map((f) => `<div class="chart-card"><div class="chart-svg">${f.svg}</div>
        <div class="row"><button type="button" class="btn mini" data-chart="${step}|${f.id}|svg">SVG</button><button type="button" class="btn mini" data-chart="${step}|${f.id}|png">PNG (300 DPI)</button></div></div>`).join('')}
    </details>` : ''}
  </div>`;
}
document.addEventListener('click', async (e) => {
  const mapBtn = e.target.closest('[data-map]');
  const chartBtn = e.target.closest('[data-chart]');
  if (!mapBtn && !chartBtn) return;
  const status = e.target.closest('.exports')?.querySelector('.export-status');
  const btn = mapBtn ?? chartBtn;
  btn.disabled = true;
  try {
    if (mapBtn) {
      const { name, blob } = await exportMap(mapBtn.dataset.map, null, status);
      saveBlob(`openhvra-${name.replace('.png', '')}-${stamp()}.png`, blob);
      if (status) status.textContent = 'Map saved (A4 landscape, 300 DPI).';
    } else {
      const [step, id, kind] = chartBtn.dataset.chart.split('|');
      const fig = figuresFor(snapshot(), step).find((f) => f.id === id);
      const name = `openhvra-${id}-${stamp()}`;
      if (kind === 'svg') saveBlob(`${name}.svg`, new Blob([fig.svg], { type: 'image/svg+xml' }));
      else saveBlob(`${name}.png`, await svgToPng(fig.svg));
    }
  } catch (err) {
    if (status) status.innerHTML = `<span class="warn">Export failed: ${escapeHtml(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});
// Every map for the package: one per step that ran, plus each multi-hazard view.
async function buildMaps(onStatus) {
  const jobs = [['population']];
  if (state.exposure) jobs.push(['exposure']);
  if (state.risk) jobs.push(['flood']);
  if (state.sviDone) jobs.push(['svi']);
  if (state.mh) {
    jobs.push(['mh', 'mhi']);
    if (state.mh.withSvi) jobs.push(['mh', 'risk']);
    for (const k of state.mh.keys) jobs.push(['mh', k]);
  }
  const out = [];
  for (const [i, [step, view]] of jobs.entries()) {
    onStatus?.(`Rendering map ${i + 1} of ${jobs.length} at 300 DPI…`);
    out.push(await exportMap(step, view));
  }
  return out;
}
// ---- Report & downloads (step 8) --------------------------------------------------------------

// The elevation actually used by the analyses (or the chosen source if none ran yet).
function elevationInfo() {
  const dem = state.dem?.dem;
  const src = ELEVATION_SOURCES[dem?.source ?? elevationSource()];
  return {
    used: !!dem,
    chosen: ELEVATION_SOURCES[elevationSource()].label,
    source: src.label,
    label: dem?.label ?? src.label,
    gridM: dem?.resolutionM ?? null,
    files: dem?.files ?? [],
    fallback: dem?.fallback ?? '',
    credit: src.credit,
    short: src.short,
  };
}
// Everything the export needs, as currently shown in the app.
export function snapshot() {
  const ds = state.dataset;
  const aoi = state.loadedAoi;
  const names = { rect: 'Rectangle', circle: 'Circle', polygon: 'Polygon', upload: 'Uploaded area' };
  const [w, s, e, n] = ds.bbox;
  const finance = state.risk ? financeParams() : null;
  return {
    generated: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    dateLabel: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    version: VERSION,
    ds,
    aoi,
    areaLabel: aoi ? `${names[aoi.type]}${aoi.name ? ` (${aoi.name})` : ''}` : 'Map view',
    areaKm2: aoi ? aoiArea(aoi.polygons) / 1e6 : bboxAreaKm2([w, s, e, n]),
    loadOpts: state.loadOpts,
    completeness: state.completeness,
    addedBuildings: state.addedBuildings,
    addedFacilities: state.addedFacilities,
    facilityCheck: state.facilityCheck,
    exposure: state.exposure,
    risk: state.risk,
    riskScenario: state.riskScenario ?? 0,
    finance,
    layers: state.risk ? financeLayers(state.risk.curve, finance) : null,
    svi: state.sviDone,
    shares: shares(),
    mh: state.mh,
    elevation: elevationInfo(),
  };
}
// Which steps have run, each with its own detailed CSV.
export function updateReportChecklist() {
  const ran = { population: !!state.dataset, exposure: !!state.exposure, flood: !!state.risk, svi: !!state.sviDone, mh: !!state.mh };
  $('report-checklist').innerHTML = STEPS.map((st) => {
    const done = ran[st.key];
    return `<li class="${done ? 'done' : 'todo'}"><span class="mark">${done ? '✓' : '–'}</span><span class="label">${st.label}${done ? '' : ' <span class="small">(not run, left out)</span>'}</span>${
      done ? `<button type="button" class="btn mini" data-step="${st.key}" title="Detailed table for this step">CSV</button>` : ''}</li>`;
  }).join('');
  $('dl-package').disabled = $('dl-buildings').disabled = $('dl-facilities').disabled = !state.dataset;
  $('dl-matrix').disabled = !state.mh;
}
$('report-step').addEventListener('toggle', updateReportChecklist);
$('report-checklist').addEventListener('click', (e) => {
  const key = e.target.closest('[data-step]')?.dataset.step;
  if (!key || !state.dataset) return;
  const st = STEPS.find((s) => s.key === key);
  download(`openhvra-${st.file.replace('.csv', '')}-${stamp()}.csv`, stepCSV(snapshot(), key), 'text/csv');
});
updateReportChecklist();
export const stamp = () => new Date().toISOString().slice(0, 10);
$('dl-package').addEventListener('click', async () => {
  if (!state.dataset) return;
  $('dl-package').disabled = true;
  $('report-status').textContent = 'Building the package…';
  try {
    const S = snapshot();
    if ($('pkg-maps').checked) S.mapFiles = await buildMaps((t) => ($('report-status').textContent = t));
    $('report-status').textContent = 'Building charts and the package…';
    const zip = await buildPackage(S);
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    Object.assign(document.createElement('a'), { href: url, download: `openhvra-${stamp()}.zip` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    $('report-status').textContent = `Package ready (${(zip.length / 1e6).toFixed(1)} MB). Open README.txt first.`;
  } catch (err) {
    $('report-status').innerHTML = `<span class="warn">Could not build the package: ${escapeHtml(err.message)}</span>`;
  } finally {
    $('dl-package').disabled = false;
  }
});
$('dl-buildings').addEventListener('click', () => download(`openhvra-buildings-${stamp()}.csv`, buildingsCSV(snapshot()), 'text/csv'));
$('dl-facilities').addEventListener('click', () => download(`openhvra-facilities-${stamp()}.csv`, facilitiesCSV(snapshot()), 'text/csv'));
$('dl-matrix').addEventListener('click', () => download(`openhvra-risk-matrix-${stamp()}.csv`, matrixCSV(snapshot()), 'text/csv'));
