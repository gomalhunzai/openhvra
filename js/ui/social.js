// Step 6: social vulnerability.

import { stepCSV, stepGeoJSON } from '../report.js';
import { readSpatialFiles, polygonFeatures, ACCEPT } from '../upload.js';
import { SVI_INDICATORS, SVI_CLASSES, GROUPS, DEFAULT_SHARES, fetchCountryShares, groupCounts, prepareCensus, computeSVI, classifySVI, sviSummary } from '../social.js';
import { $, EMPTY, state } from './shared.js';
import { escapeHtml, fmt, pctOf, row } from './format.js';
import { layerCtrl, map } from './map.js';
import { combineMH } from './multihazard.js';
import { download, exportsBlock, snapshot, stamp, updateReportChecklist } from './exports.js';
import { refresh3D } from './view3d.js';

// ---- Social vulnerability ---------------------------------------------------------------------

$('share-inputs').innerHTML = Object.entries(GROUPS).map(([k, g]) =>
  `<label class="field"><span>${g.label}</span><input type="number" id="share-${k}" min="0" max="100" step="0.1" value="${DEFAULT_SHARES[k]}"></label>`).join('');
$('svi-indicators').innerHTML = Object.entries(SVI_INDICATORS).map(([k, ind]) =>
  `<label><input type="checkbox" class="svi-ind" value="${k}" ${k === 'census' ? 'disabled' : 'checked'}><span>${ind.label}<span class="muted">${ind.note}</span></span></label>`).join('');
const census = { features: [], name: '' };
export function shares() {
  return Object.fromEntries(Object.keys(GROUPS).map((k) => [k, Math.min(100, Math.max(0, +$(`share-${k}`).value || 0))]));
}
$('wb-fetch').addEventListener('click', async () => {
  const ds = state.dataset;
  if (!ds) return;
  const [w, s, e, n] = ds.bbox;
  $('wb-status').textContent = 'Looking up national figures…';
  $('wb-fetch').disabled = true;
  try {
    const res = await fetchCountryShares((w + e) / 2, (s + n) / 2);
    const found = [];
    for (const [k, v] of Object.entries(res.values)) {
      $(`share-${k}`).value = v.value.toFixed(1);
      found.push(`${GROUPS[k].label.toLowerCase()} ${v.value.toFixed(1)}% (${v.year})`);
    }
    const missing = Object.entries(GROUPS).filter(([k, g]) => g.wb && !res.values[k]).map(([, g]) => g.label.toLowerCase());
    $('wb-status').innerHTML = `${escapeHtml(res.country)}: ${found.join(', ') || 'no figures available'}.` +
      (missing.length ? ` No recent data for ${missing.join(', ')}; keep or edit the value.` : '') +
      ' Disability uses the WHO global estimate of 16%. Source: World Bank WDI.';
    if (state.sviDone) renderSVI();
  } catch (err) {
    $('wb-status').innerHTML = `<span class="warn">Could not fetch national figures (${escapeHtml(err.message)}). Enter them manually.</span>`;
  } finally {
    $('wb-fetch').disabled = false;
  }
});
for (const k of Object.keys(GROUPS)) $(`share-${k}`).addEventListener('change', () => state.sviDone && renderSVI());
$('census-file').accept = ACCEPT;
$('census-file').addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files?.length) return;
  const label = [...files].map((f) => f.name).join(', ');
  $('census-status').textContent = `Reading ${label}…`;
  try {
    const { features, format } = await readSpatialFiles(files);
    const polys = polygonFeatures(features);
    if (!polys.length) throw new Error('the file has no polygons');
    // Numeric fields: present and numeric in most features.
    const keys = [...new Set(polys.flatMap((f) => Object.keys(f.properties ?? {})))];
    const numeric = keys.filter((k) => polys.filter((f) => Number.isFinite(parseFloat(f.properties?.[k]))).length >= polys.length * 0.8);
    if (!numeric.length) throw new Error('no numeric fields found');
    census.features = polys;
    census.name = label;
    $('census-field').innerHTML = numeric.map((k) => `<option>${escapeHtml(k)}</option>`).join('');
    const guess = numeric.find((k) => /pov|depriv|vuln|poor|index|rate|pct|percent/i.test(k));
    if (guess) $('census-field').value = guess;
    $('census-opts').classList.remove('hidden');
    const box = document.querySelector('.svi-ind[value=census]');
    box.disabled = false;
    box.checked = true;
    $('census-status').textContent = `${polys.length} areas from ${label} (${format}). Pick the field to use.`;
  } catch (err) {
    $('census-status').innerHTML = `<span class="warn">Could not use ${escapeHtml(label)}: ${escapeHtml(err.message)}</span>`;
  } finally {
    e.target.value = '';
  }
});
// The uploaded census layer, for saving in a project.
export function censusForProject() {
  if (!census.features.length) return null;
  return { name: census.name, field: $('census-field').value, higher: $('census-higher').checked, features: census.features };
}
// Puts back a census layer saved in a project (null clears it).
export function restoreCensus(c) {
  const box = document.querySelector('.svi-ind[value=census]');
  census.features = c?.features ?? [];
  census.name = c?.name ?? '';
  if (!c) {
    $('census-field').innerHTML = '';
    $('census-opts').classList.add('hidden');
    $('census-status').textContent = '';
    box.disabled = true;
    box.checked = false;
    return;
  }
  const keys = [...new Set(c.features.flatMap((f) => Object.keys(f.properties ?? {})))];
  if (c.field && !keys.includes(c.field)) keys.unshift(c.field);
  $('census-field').innerHTML = keys.map((k) => `<option>${escapeHtml(k)}</option>`).join('');
  $('census-field').value = c.field;
  $('census-higher').checked = c.higher;
  $('census-opts').classList.remove('hidden');
  box.disabled = false;
  $('census-status').textContent = `${c.features.length} areas from ${c.name || 'the project'} (restored from the project).`;
}
export function runSVI() {
  const ds = state.dataset;
  if (!ds) return;
  const use = new Set([...document.querySelectorAll('.svi-ind:checked')].map((i) => i.value));
  if (!use.size) {
    $('svi-results').innerHTML = '<p class="warn">Select at least one indicator.</p>';
    return;
  }
  let cen = null;
  if (use.has('census') && census.features.length) {
    try {
      cen = prepareCensus(ds, census.features, $('census-field').value, $('census-higher').checked);
    } catch (err) {
      $('census-status').innerHTML = `<span class="warn">${escapeHtml(err.message)}</span>`;
      use.delete('census');
    }
  }
  const t0 = performance.now();
  computeSVI(ds, use, cen);
  state.sviDone = { use, census: cen, ms: Math.round(performance.now() - t0) };
  classifyAndShowSVI();
  layerCtrl.setAvailable('svi', true, true);
  renderSVI();
  if (state.mh) combineMH(false);
  updateReportChecklist();
}
function classifyAndShowSVI() {
  const ds = state.dataset;
  state.sviDone.mode = $('svi-mode').value;
  state.sviDone.breaks = classifySVI(ds, state.sviDone.mode);
  map.getSource('svi').setData({
    type: 'FeatureCollection',
    features: ds.buildings.filter((b) => b.pop > 0 && b.svi != null).map((b) => ({ ...b.feature, properties: { fid: b.fid, cls: b.sviClass } })),
  });
  refresh3D();
}
$('svi-mode').addEventListener('change', () => {
  if (!state.sviDone) return;
  classifyAndShowSVI();
  renderSVI();
  if (state.mh) combineMH(false);
});
export function renderSVI() {
  const ds = state.dataset;
  const { use, census: cen } = state.sviDone;
  const sh = shares();
  const all = sviSummary(ds);
  const high = all.classes[3].pop + all.classes[4].pop;
  const groups = groupCounts(ds.popTotal, sh);
  const R = state.risk;
  const sc = R?.scenarios[state.riskScenario];
  const flooded = sc && sviSummary(ds, (b) => b.depths?.[state.riskScenario] > 0);

  let html = `
    <div class="kpis">
      <div class="kpi alert"><b>${fmt(Math.round(high))}</b><span>residents in high or very high vulnerability homes (${pctOf(high, all.popTotal)})</span></div>
      <div class="kpi"><b>${fmt(Math.round(all.popTotal))}</b><span>residents scored</span></div>
    </div>
    <div class="sub">Residents by vulnerability class</div>
    <table class="list"><tr><th>Class</th><th class="num">Homes</th><th class="num">Residents</th>${flooded ? `<th class="num">Flooded (${sc.rp}-yr)</th>` : ''}</tr>
    ${SVI_CLASSES.map((c, i) => `<tr><td><span class="dot" style="background:${c.color}"></span>${c.label}</td><td class="num">${fmt(all.classes[i].buildings)}</td><td class="num">${fmt(Math.round(all.classes[i].pop))}</td>${flooded ? `<td class="num">${fmt(Math.round(flooded.classes[i].pop))}</td>` : ''}</tr>`).join('')}
    </table>`;
  if (flooded) {
    const fh = flooded.classes[3].pop + flooded.classes[4].pop;
    html += `<p class="note"><b>Priority:</b> ${fmt(Math.round(fh))} highly vulnerable residents live in homes flooded in the ${sc.rp}-year flood.</p>`;
  }
  html += `<div class="sub">Vulnerable groups</div>
    <table class="list"><tr><th>Group</th><th class="num">Share</th><th class="num">In area</th>${sc ? `<th class="num">Flooded (${sc.rp}-yr)</th>` : ''}</tr>
    ${Object.entries(GROUPS).map(([k, g]) => `<tr><td>${g.label}</td><td class="num">${sh[k]}%</td><td class="num">${fmt(Math.round(groups[k]))}</td>${sc ? `<td class="num">${fmt(Math.round((sc.pop * sh[k]) / 100))}</td>` : ''}</tr>`).join('')}
    </table>
    ${state.sviDone.mode === 'relative' ? `<p class="note">Classes rank homes within this area: score breaks at ${state.sviDone.breaks.map((b) => b.toFixed(2)).join(', ')}. Switch to absolute classes to compare areas.</p>` : ''}
    <p class="note">Group counts apply the shares evenly to the modelled residents; groups overlap (for example, a child in poverty counts in both).</p>
    <div class="sub">What drives vulnerability <span class="muted">(average score, 0–1)</span></div>
    <table class="list">
    ${[...use].filter((k) => all.means[k] != null).map((k) => row(SVI_INDICATORS[k].label + (k === 'census' && cen ? ` (${escapeHtml(cen.field)})` : ''), all.means[k].toFixed(2))).join('')}
    </table>`;
  if (!R) html += '<p class="note">Run the flood risk analysis (step 5) to see how many vulnerable people are in the flood zone.</p>';
  html += `<p class="note">Computed for ${fmt(ds.buildings.filter((b) => b.pop > 0).length)} homes in ${state.sviDone.ms} ms. The index reflects mapped OSM facilities; missing clinics or shelters in OSM make an area look more vulnerable than it is.</p>
    <div class="row" style="margin-top:8px"><button id="dl-svi-csv" class="btn">Social vulnerability CSV</button><button id="dl-svi-geojson" class="btn">GeoJSON (points)</button></div>
    <p class="note">One row per home: score, class and rank, each indicator, census value, distances to health and emergency services, estimated children, elderly, people with disabilities and people in poverty${state.risk ? ', and flood depth' : ''}.</p>`;
  $('svi-results').innerHTML = html + exportsBlock('svi');
  $('dl-svi-csv').addEventListener('click', () => download(`openhvra-social-vulnerability-${stamp()}.csv`, stepCSV(snapshot(), 'svi'), 'text/csv'));
  $('dl-svi-geojson').addEventListener('click', () => download(`openhvra-social-vulnerability-${stamp()}.geojson`, stepGeoJSON(snapshot(), 'svi'), 'application/geo+json'));
}
export function clearSVI() {
  state.sviDone = null;
  layerCtrl.setAvailable('svi', false);
  map.getSource('svi')?.setData(EMPTY);
  $('svi-results').innerHTML = '';
}
$('run-svi').addEventListener('click', runSVI);
