// Step 7: multi-hazard risk.

import { CRITICAL_GROUPS } from '../osm.js';
import { ringBBox } from '../spatial.js';
import { traceLakes, pathIndex, GLOF_DEFAULTS } from '../glof.js';
import { readSpatialFiles, ACCEPT } from '../upload.js';
import { HAZARDS, HIGH, NOISE_FLOOR, LIKELIHOOD, IMPACT, IMPACT_STEPS, rating, SCORE_CLASSES, scoreClass, loadHazardContext, lakesFromFeatures, scoreHazards, combine, riskMatrix } from '../hazards.js';
import { $, EMPTY, state } from './shared.js';
import { escapeHtml, fmt, pctOf } from './format.js';
import { layerCtrl, map } from './map.js';
import { ensureDEM } from './flood.js';
import { runSVI } from './social.js';
import { csvOf, download, exportsBlock, pointsGeoJSON, updateReportChecklist } from './exports.js';
import { glofInputsKey, lakeTable, markedLakes, showCryo } from './glof.js';
import { refresh3D } from './view3d.js';

// ---- Multi-hazard risk ------------------------------------------------------------------------

const HZ_SETTINGS = {
  river: () => `100-yr level: ${floodLevel()} m (step 5)`,
  coastal: () => '<label>Sea level + surge <input type="number" id="hz-coast" min="0" max="20" step="0.5" value="2" style="width:60px"> m</label>',
  avalanche: () => '<label>Snow line <input type="number" id="hz-snow" min="0" max="7000" step="100" value="2500" style="width:72px"> m</label>',
  earthquake: () => 'USGS catalogue + building type',
  glof: () => 'Traced lake outflow paths (below)',
};
function floodLevel() {
  const rows = [...document.querySelectorAll('#scenario-table tbody tr')].map((tr) => ({ rp: +tr.querySelector('.sc-rp').value, level: +tr.querySelector('.sc-level').value }));
  const r100 = rows.find((r) => r.rp === 100) ?? rows.sort((a, b) => b.rp - a.rp)[0];
  return r100?.level ?? 3;
}
$('hz-table').tBodies[0].innerHTML = Object.entries(HAZARDS).map(([k, h]) => `<tr>
  <td><label><input type="checkbox" class="hz-use" value="${k}" checked> ${h.label}</label></td>
  <td><input type="number" class="hz-w" data-k="${k}" min="0" max="1" step="0.1" value="1" aria-label="${h.label} weight" style="width:56px"></td>
  <td class="setting" data-setting="${k}">${HZ_SETTINGS[k]?.() ?? ''}</td></tr>`).join('');
$('scenario-table').addEventListener('change', () => (document.querySelector('[data-setting=river]').textContent = HZ_SETTINGS.river()));
export const lakeUploads = [];
$('lake-file').accept = ACCEPT;
$('lake-file').addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files?.length) return;
  try {
    const { features } = await readSpatialFiles(files);
    const lakes = lakesFromFeatures(features);
    if (!lakes.length) throw new Error('no points or polygons found');
    lakes.forEach((l, i) => (l.id = `up:${lakeUploads.length + i}`));
    lakeUploads.push(...lakes);
    $('lake-status').textContent = `${lakeUploads.length} uploaded lake(s) will be included in the GLOF assessment.`;
  } catch (err) {
    $('lake-status').innerHTML = `<span class="warn">Could not read the lake file: ${escapeHtml(err.message)}</span>`;
  } finally {
    e.target.value = '';
  }
});
function mhWeights(use) {
  return Object.fromEntries([...use].map((k) => [k, Math.min(1, Math.max(0, +document.querySelector(`.hz-w[data-k=${k}]`).value || 0))]));
}
export async function runMH() {
  const ds = state.dataset;
  if (!ds) return;
  const use = new Set([...document.querySelectorAll('.hz-use:checked')].map((i) => i.value));
  if (!use.size) {
    $('mh-status').innerHTML = '<span class="warn">Select at least one hazard.</span>';
    return;
  }
  $('run-mh').disabled = true;
  const t0 = performance.now();
  try {
    const dem = await ensureDEM($('mh-status'));
    // Context data per hazard, downloaded only for the ticked hazards and kept
    // for this area so ticking another hazard later fetches just that part.
    const key = ds.bbox.join(',');
    if (state.hzCtx?.key !== key) {
      state.hzCtx = { key, ctx: { quakes: null, glaciers: 0, lakes: [], coast: [], errors: {} }, have: {} };
    }
    const { ctx, have } = state.hzCtx;
    const need = {
      quakes: use.has('earthquake') && !have.quakes,
      glof: use.has('glof') && have.glof !== glofInputsKey(), // refetch when lakes or glaciers are added
      coast: use.has('coastal') && !have.coast,
    };
    const { parts, errors } = await loadHazardContext(ds.bbox, {
      need, extraLakes: [...lakeUploads, ...markedLakes()], markBoxes: state.marks.glaciers.map((g) => ringBBox(g.ring)),
      onStatus: (t) => ($('mh-status').textContent = t),
    });
    Object.assign(ctx, parts);
    for (const k of ['earthquake', 'glof', 'coastal']) {
      const asked = { earthquake: need.quakes, glof: need.glof, coastal: need.coast }[k];
      if (asked) ctx.errors[k] = errors[k];
    }
    if (need.quakes && parts.quakes) have.quakes = true;
    if (need.glof && parts.lakes) have.glof = glofInputsKey();
    if (need.coast && parts.coast) have.coast = true;
    if ($('hz-svi').checked && !state.sviDone) {
      $('mh-status').textContent = 'Computing social vulnerability…';
      runSVI();
    }
    $('mh-status').textContent = 'Scoring hazards for every building…';
    await new Promise((r) => setTimeout(r, 20)); // let the status paint
    const P = {
      use,
      floodLevel: floodLevel(),
      coastLevel: +$('hz-coast').value || 2,
      snowLine: +$('hz-snow').value || 2500,
      glof: { ...GLOF_DEFAULTS, h0: Math.max(1, +$('glof-h0').value || GLOF_DEFAULTS.h0), h30: Math.max(0, +$('glof-h30').value || GLOF_DEFAULTS.h30) },
    };
    if (use.has('glof') && ctx.lakes.length) {
      for (const l of ctx.lakes) l.userPath = state.marks.paths[l.id] ?? null;
      await traceLakes(ctx.lakes, ctx.waterways ?? [], ds.bbox, P.glof, { onStatus: (t) => ($('mh-status').textContent = t) });
      P.glofIdx = pathIndex(ds, ctx.lakes);
      $('mh-status').textContent = 'Scoring hazards for every building…';
    }
    showCryo(use.has('glof') ? ctx : null);
    const notes = scoreHazards(ds, dem, ctx, P);
    state.mh = { use, notes, weights: mhWeights(use), ctx, settings: P, ms: Math.round(performance.now() - t0), show: 'mhi' };
    combineMH();
    $('mh-status').textContent = `Scored ${fmt(ds.points.length)} buildings and facilities for ${use.size} hazards in ${(state.mh.ms / 1000).toFixed(1)}s (elevation: ${dem.label}).`;
    if (dem.fallback) $('mh-status').innerHTML += ` <span class="warn">${escapeHtml(dem.fallback)}.</span>`;
  } catch (err) {
    $('mh-status').innerHTML = `<span class="warn">Multi-hazard analysis failed: ${escapeHtml(err.message)}</span>`;
  } finally {
    $('run-mh').disabled = false;
  }
}
// Recombine scores (weights, population or social vulnerability changed) and
// redraw; `show` also switches the map to the multi-hazard layer.
export function combineMH(show = true) {
  const mh = state.mh;
  mh.weights = mhWeights(mh.use);
  // Social vulnerability as shown on its map: rank within the area in relative
  // mode, the absolute 0–1 score otherwise.
  const relative = state.sviDone?.mode === 'relative';
  const vuln = $('hz-svi').checked && state.sviDone ? (p) => (relative ? p.sviRank : p.svi) : null;
  mh.keys = combine(state.dataset, mh.weights, mh.notes, vuln);
  mh.withSvi = !!vuln;
  mh.matrix = riskMatrix(state.dataset, mh.keys);
  renderMH();
  if (show) showMHLayer();
  else updateMHSource();
  updateReportChecklist();
}
document.querySelector('#hz-table').addEventListener('change', (e) => {
  if (state.mh && e.target.classList.contains('hz-w')) combineMH();
});
$('hz-svi').addEventListener('change', () => state.mh && combineMH());
function renderMH() {
  const ds = state.dataset;
  const mh = state.mh;
  const homes = ds.buildings.filter((b) => b.pop > 0 && b.hz);
  const popOf = (f) => homes.filter(f).reduce((a, b) => a + b.pop, 0);
  const total = popOf(() => true);
  const highMHI = popOf((b) => b.mhi >= HIGH);
  const multi = popOf((b) => b.highHazards >= 2);
  const withRisk = homes.some((b) => b.risk != null);
  const highRisk = popOf((b) => b.risk != null && b.risk >= 0.6);
  let html = `
    <div class="kpis">
      <div class="kpi alert"><b>${fmt(Math.round(highMHI))}</b><span>residents at high multi-hazard level (${pctOf(highMHI, total)})</span></div>
      <div class="kpi alert"><b>${fmt(Math.round(multi))}</b><span>residents facing two or more high hazards</span></div>
      ${withRisk ? `<div class="kpi alert"><b>${fmt(Math.round(highRisk))}</b><span>residents at high or very high combined risk</span></div>` : ''}
      <div class="kpi"><b>${fmt(Math.round(total))}</b><span>residents assessed</span></div>
    </div>`;

  const q = mh.ctx.quakes;
  if (q && mh.use.has('earthquake')) {
    const lvl = SCORE_CLASSES[scoreClass(q.score)].label.toLowerCase();
    html += `<div class="sub">Earthquake hazard: ${lvl}</div>
      <p class="note">${fmt(q.n150)} earthquakes of magnitude 5+ within 150 km since 1973 (about one every ${q.rate > 0 ? (1 / q.rate).toFixed(1) : '∞'} years).
      ${q.maxNear ? `Largest within 100 km: M${q.maxNear.mag.toFixed(1)}, ${q.maxNear.year}, ${escapeHtml(q.maxNear.place ?? '')}.` : 'None of M5+ within 100 km since 1900.'}</p>`;
    if (q.largest.length) {
      html += `<table class="list"><tr><th>Largest within 300 km</th><th class="num">Mag.</th><th class="num">Year</th><th class="num">Distance</th></tr>
        ${q.largest.slice(0, 5).map((e) => `<tr><td>${escapeHtml(e.place ?? '')}</td><td class="num">${e.mag.toFixed(1)}</td><td class="num">${e.year}</td><td class="num">${Math.round(e.dist)} km</td></tr>`).join('')}</table>`;
    }
  }

  html += `<div class="sub">By hazard <span class="muted">(high = score ≥ ${HIGH})</span></div>
    <table class="list"><tr><th>Hazard</th><th class="num">Homes</th><th class="num">Residents</th><th class="num">Critical</th><th class="num">Rating</th></tr>`;
  for (const k of mh.use) {
    if (mh.notes[k]) {
      html += `<tr><td>${HAZARDS[k].label}</td><td colspan="4" class="muted small">${escapeHtml(mh.notes[k])}</td></tr>`;
      continue;
    }
    const hi = homes.filter((b) => (b.hz[k] ?? 0) >= HIGH);
    const crit = ds.facilities.filter((f) => (f.hz?.[k] ?? 0) >= HIGH && CRITICAL_GROUPS.has(f.group)).length;
    const m = mh.matrix.find((x) => x.key === k);
    html += `<tr><td>${HAZARDS[k].label}</td><td class="num">${fmt(hi.length)}</td><td class="num">${fmt(Math.round(hi.reduce((a, b) => a + b.pop, 0)))}</td><td class="num">${fmt(crit)}</td><td class="num">${m.rating}</td></tr>`;
  }
  html += '</table>';

  if (mh.use.has('glof') && mh.ctx.lakes?.length) html += lakeTable(mh.ctx);

  // Likelihood × impact matrix, then the calculation behind it.
  html += `<div class="sub">Risk matrix</div><table class="matrix" aria-label="Risk matrix: likelihood by impact"><tr><th class="rowh"></th>${IMPACT.map((t) => `<th>${t}</th>`).join('')}</tr>`;
  for (let l = 5; l >= 1; l--) {
    html += `<tr><th class="rowh">${LIKELIHOOD[l - 1]}</th>`;
    for (let i = 1; i <= 5; i++) {
      const r = rating(l * i);
      const here = mh.matrix.filter((m) => m.likelihood === l && m.impact === i).map((m) => HAZARDS[m.key].short);
      html += `<td class="r-${r.toLowerCase()}" title="${r}"><b>${r}</b>${here.join('<br>')}</td>`;
    }
    html += '</tr>';
  }
  html += `</table>
    <div class="sub">How the matrix is calculated</div>
    <div class="table-scroll"><table class="list calc">
      <tr><th>Hazard</th><th class="num">Mean score</th><th class="num">90th pct.</th><th class="num">Likelihood</th><th class="num">Residents at high hazard</th><th class="num">Impact (base)</th><th class="num">Health / school / emergency at high hazard (+1)</th><th class="num">Impact</th><th class="num">L × I</th><th class="num">Rating</th></tr>
      ${mh.matrix.map((m) => `<tr><td>${HAZARDS[m.key].label}</td><td class="num">${m.mean.toFixed(2)}</td><td class="num">${m.p90.toFixed(2)}</td>
        <td class="num">${m.likelihood} ${LIKELIHOOD[m.likelihood - 1]}</td><td class="num">${fmt(Math.round(m.exposedPop))} (${(100 * m.exposedShare).toFixed(1)}%)</td>
        <td class="num">${m.impactBase}</td><td class="num">${m.critical ? `yes (${m.criticalCount})` : 'no'}</td><td class="num">${m.impact} ${IMPACT[m.impact - 1]}</td>
        <td class="num">${m.score}</td><td class="num">${m.rating}</td></tr>`).join('')}
    </table></div>
    <p class="note"><b>Likelihood</b> = 1 + ⌊5 × 90th-percentile hazard score across homes⌋ (max 5).
      <b>Impact (base)</b> = 1 + one step for each threshold reached by the share of residents at high hazard (score ≥ ${HIGH}): ${IMPACT_STEPS.map((t) => `${t * 100}%`).join(', ')}.
      <b>Impact</b> = base + 1 (max 5) if a health, education or emergency facility is at high hazard.
      <b>Rating</b> from L × I: 1–4 Low, 5–9 Medium, 10–16 High, 20–25 Extreme.</p>`;

  // Residents by class for the index and the combined risk.
  const cls = (f) => SCORE_CLASSES.map((c, i) => popOf((b) => f(b) != null && scoreClass(f(b)) === i));
  const mhiC = cls((b) => b.mhi);
  const riskC = withRisk ? cls((b) => b.risk) : null;
  html += `<div class="sub">Residents by class</div><table class="list"><tr><th>Class</th><th class="num">Multi-hazard</th>${riskC ? '<th class="num">Combined risk</th>' : ''}</tr>
    ${SCORE_CLASSES.map((c, i) => `<tr><td><span class="dot" style="background:${c.color}"></span>${c.label}</td><td class="num">${fmt(Math.round(mhiC[i]))}</td>${riskC ? `<td class="num">${fmt(Math.round(riskC[i]))}</td>` : ''}</tr>`).join('')}</table>`;
  if (riskC) {
    const rel = state.sviDone?.mode === 'relative' ? "; vulnerability is each home's rank within this area" : '';
    html += `<p class="note">Combined risk = √(multi-hazard index × social vulnerability), as in INFORM${rel}. Hazard scores below ${NOISE_FLOOR} count as background and are not combined.</p>`;
  }

  const options = [['mhi', 'Multi-hazard index'], ...(withRisk ? [['risk', 'Combined risk (hazard × social vulnerability)']] : []),
    ...mh.keys.map((k) => [k, HAZARDS[k].label])];
  html += `<label class="field" style="margin-top:10px"><span>Show on map</span><select id="mh-show">${options.map(([v, t]) => `<option value="${v}" ${v === mh.show ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <div class="ramp">${SCORE_CLASSES.map((c) => `<span style="background:${c.color}" title="${c.label}"></span>`).join('')}</div>
    <div class="row small muted" style="justify-content:space-between">${SCORE_CLASSES.map((c) => `<span>${c.label}</span>`).join('')}</div>
    <div class="row" style="margin-top:8px"><button id="dl-mh-csv" class="btn">Multi-hazard CSV</button><button id="dl-mh-geojson" class="btn">GeoJSON (points)</button></div>
    <p class="note">Screening estimates from ~30 m elevation, OpenStreetMap and the USGS catalogue. Verify hotspots in the field and with official hazard maps.</p>`;
  $('mh-results').innerHTML = html + exportsBlock('mh');
  $('mh-show').addEventListener('change', (e) => {
    mh.show = e.target.value;
    showMHLayer();
  });
  $('dl-mh-csv').addEventListener('click', () => download('openhvra-multi-hazard.csv', csvOf(mhRows()), 'text/csv'));
  $('dl-mh-geojson').addEventListener('click', () => download('openhvra-multi-hazard.geojson', pointsGeoJSON(mhRows()), 'application/geo+json'));
}
export function mhValue(p, k = state.mh.show) {
  return k === 'mhi' ? p.mhi : k === 'risk' ? p.risk : p.hz?.[k];
}
// Buildings coloured for one multi-hazard view ('mhi', 'risk' or a hazard key).
export function mhFeatures(k = state.mh.show) {
  const features = [];
  for (const b of state.dataset.buildings) {
    const v = mhValue(b, k);
    if (v == null || (k === 'risk' && b.pop <= 0)) continue;
    features.push({ ...b.feature, properties: { fid: b.fid, v } });
  }
  return { type: 'FeatureCollection', features };
}
function updateMHSource() {
  map.getSource('mh').setData(mhFeatures());
  refresh3D();
}
function showMHLayer() {
  updateMHSource();
  layerCtrl.setAvailable('mh', true, true);
}
function mhRows() {
  return state.dataset.points.filter((p) => p.hz).map((p) => {
    const props = {};
    for (const k of state.mh.keys) props[`hz_${k}`] = p.hz[k] != null ? Math.round(p.hz[k] * 100) / 100 : null;
    props.multi_hazard = p.mhi != null ? Math.round(p.mhi * 100) / 100 : null;
    props.high_hazards = p.highHazards;
    if (p.risk != null) props.combined_risk = Math.round(p.risk * 100) / 100;
    return { p, props };
  });
}
export function clearMH() {
  state.mh = null;
  showCryo(null);
  layerCtrl.setAvailable('mh', false);
  map.getSource('mh')?.setData(EMPTY);
  $('mh-results').innerHTML = '';
  $('mh-status').textContent = '';
}
$('run-mh').addEventListener('click', runMH);
