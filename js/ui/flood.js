// Step 5: flood risk and risk finance.

import { BUILDING_CLASSES } from '../osm.js';
import { SOURCES } from '../analysis.js';
import { floodRisk, financeLayers, DEFAULT_SCENARIOS, DEFAULT_COSTS, DEFAULT_FINANCE } from '../risk.js';
import { CONSTRUCTION_TYPES, costsFor } from '../costs.js';
import { lossCurve } from '../chart.js';
import { loadElevation, elevationSource, ELEVATION_SOURCES } from '../elevation.js';
import { $, DEPTH_CLASSES, EMPTY, state } from './shared.js';
import { compact, escapeHtml, featureLabel, fmt, m, money, pctOf, row } from './format.js';
import { layerCtrl, map } from './map.js';
import { renderSVI } from './social.js';
import { exportsBlock, updateReportChecklist } from './exports.js';
import { refresh3D } from './view3d.js';

// ---- Flood risk ---------------------------------------------------------------------------

$('scenario-table').tBodies[0].innerHTML = DEFAULT_SCENARIOS.map((s) => `<tr>
  <td><input type="number" class="sc-rp" min="2" max="10000" step="1" value="${s.rp}" aria-label="Return period in years"></td>
  <td><input type="number" class="sc-level" min="0" max="30" step="0.1" value="${s.level}" aria-label="Water level in metres"></td></tr>`).join('');
$('cost-table').tBodies[0].innerHTML = Object.entries(DEFAULT_COSTS).map(([k, v]) => `<tr>
  <td>${escapeHtml(BUILDING_CLASSES[k])}</td>
  <td><input type="number" id="cost-${k}" class="cost-in" min="0" step="10" value="${v}" aria-label="${escapeHtml(BUILDING_CLASSES[k])}: cost per m²"></td>
  <td><input type="number" id="contents-${k}" class="cost-in" min="0" max="300" step="5" value="30" aria-label="${escapeHtml(BUILDING_CLASSES[k])}: contents as % of building"></td></tr>`).join('');
// Where the costs in the table came from; `edited` is set when the user changes a value.
state.costInfo = { source: 'placeholder', label: 'Placeholder values (costs not looked up)', edited: false, typeFactors: {} };
function costSourceText(c) {
  if (c.source === 'gem') return `GEM Global Exposure Model v2026.0.0, ${c.region ? `${c.region}, ${c.country}` : c.country}`;
  if (c.source === 'jrc') return `JRC construction-cost formula (Huizinga et al. 2017) with the World Bank GDP per capita of ${c.country} for ${c.year} (US$ ${fmt(Math.round(c.gdpPc))}), at ${c.priceYear} US prices`;
  return c.label;
}
function showCostTypes() {
  const tf = state.costInfo.typeFactors ?? {};
  const keys = Object.keys(tf);
  $('cost-types').innerHTML = keys.length
    ? `Homes with a mapped building material are adjusted by GEM's national cost for that construction type: ${keys.map((k) => `${CONSTRUCTION_TYPES[k].toLowerCase()} ×${tf[k].toFixed(2)}`).join(', ')}.`
    : '';
}
export async function fillCosts() {
  const ds = state.dataset;
  const source = $('cost-source').value;
  if (!ds || source === 'own') return;
  const [w, s, e, n] = ds.bbox;
  $('cost-fetch').disabled = true;
  $('cost-status').textContent = 'Looking up building costs for this area…';
  try {
    const c = await costsFor(source, (w + e) / 2, (s + n) / 2, AbortSignal.timeout(20000));
    if (state.dataset !== ds || $('cost-source').value !== source) return; // superseded by a newer request
    for (const k of Object.keys(DEFAULT_COSTS)) {
      $(`cost-${k}`).value = c.costs[k];
      $(`contents-${k}`).value = c.contentsPct[k];
    }
    $('currency').value = 'USD';
    state.costInfo = { ...c, label: costSourceText(c), edited: false };
    $('cost-status').innerHTML = `Costs from the ${escapeHtml(costSourceText(c))}: replacement cost in US dollars (not depreciated).` +
      (c.source === 'gem' && c.level === 'country' ? ' No regional value for this area, so national values are used.' : '') +
      ` Edit any value to use local figures. <span class="muted">Source: ${escapeHtml(c.citation)}</span>`;
    showCostTypes();
    if (state.risk) clearRisk();
  } catch (err) {
    if (state.dataset !== ds) return;
    $('cost-status').innerHTML = `<span class="warn">Could not look up costs (${escapeHtml(err.message)}). Enter local costs, or try again.</span>`;
  } finally {
    $('cost-fetch').disabled = !state.dataset || $('cost-source').value === 'own';
  }
}
$('cost-fetch').addEventListener('click', fillCosts);
$('cost-source').addEventListener('change', () => {
  if ($('cost-source').value === 'own') {
    state.costInfo = { source: 'own', label: 'Own values entered by the user', edited: true, typeFactors: {} };
    $('cost-status').textContent = 'Enter your own cost per m² of floor area and contents share for each class, in the currency shown.';
    $('cost-fetch').disabled = true;
    showCostTypes();
  } else fillCosts();
});
document.querySelectorAll('.cost-in').forEach((el) => el.addEventListener('change', () => { state.costInfo.edited = true; }));
$('currency').addEventListener('change', () => {
  if (state.costInfo.source !== 'own' && $('currency').value.trim().toUpperCase() !== 'USD') {
    $('cost-status').innerHTML = '<span class="warn">The looked-up costs are in US dollars. Changing the currency label does not convert them: enter the costs in the new currency too.</span>';
  }
});
function riskParams() {
  const rps = [...document.querySelectorAll('.sc-rp')].map((i) => +i.value);
  const levels = [...document.querySelectorAll('.sc-level')].map((i) => +i.value);
  const seen = new Set();
  const scenarios = rps.map((rp, i) => ({ rp, level: levels[i] }))
    .filter((s) => s.rp > 1 && s.level > 0 && !seen.has(s.rp) && seen.add(s.rp));
  return {
    source: $('risk-source').value,
    maxDist: Math.max(50, +$('risk-maxdist').value || 1000),
    scenarios,
    costs: Object.fromEntries(Object.keys(DEFAULT_COSTS).map((k) => [k, Math.max(0, +$(`cost-${k}`).value || 0)])),
    contentsPct: Object.fromEntries(Object.keys(DEFAULT_COSTS).map((k) => [k, Math.max(0, +$(`contents-${k}`).value || 0)])),
    typeFactors: $('cost-source').value === 'own' ? {} : state.costInfo.typeFactors ?? {},
    costSource: state.costInfo.label + (state.costInfo.edited && state.costInfo.source !== 'own' ? ' (edited by the user)' : ''),
    costCitation: state.costInfo.citation ?? '',
    currency: $('currency').value.trim() || 'USD',
  };
}
// Elevation for the loaded area, shared by the flood and multi-hazard steps.
// Padded ~1.5 km so rivers, slopes and avalanche paths just outside are covered.
export async function ensureDEM(statusEl) {
  const ds = state.dataset;
  const key = `${elevationSource()}:${ds.bbox.join(',')}`;
  if (state.dem?.key === key) return state.dem.dem;
  const [w, s, e, n] = ds.bbox;
  const pad = 0.015;
  const name = ELEVATION_SOURCES[elevationSource()].label;
  statusEl.textContent = `Downloading elevation (${name})…`;
  const dem = await loadElevation([w - pad, s - pad, e + pad, n + pad], {
    onProgress: (done, total) => (statusEl.textContent = `Downloading elevation (${name})… ${done}/${total}`),
  });
  state.dem = { key, dem };
  return dem;
}
async function runRisk() {
  const ds = state.dataset;
  if (!ds) return;
  const P = riskParams();
  if (P.scenarios.length < 2) {
    $('risk-status').textContent = 'Enter at least two scenarios with different return periods.';
    return;
  }
  if (!ds.lines.some(SOURCES[P.source].pred)) {
    $('risk-status').innerHTML = `<span class="warn">No ${SOURCES[P.source].label.toLowerCase()} are mapped in the loaded area, so flood depth can't be estimated.</span>`;
    return;
  }
  $('run-risk').disabled = true;
  try {
    await ensureDEM($('risk-status'));
    state.riskScenario = null;
    computeRisk(P);
    layerCtrl.setAvailable('depth', true, true);
  } catch (err) {
    $('risk-status').innerHTML = `<span class="warn">Flood analysis failed: ${escapeHtml(err.message)}</span>`;
  } finally {
    $('run-risk').disabled = false;
  }
}
export function computeRisk(P = state.risk?.params ?? riskParams()) {
  const ds = state.dataset;
  if (!ds || !state.dem) return;
  const t0 = performance.now();
  state.risk = floodRisk(ds, state.dem.dem, P);
  const n = state.risk.scenarios.length;
  if (state.riskScenario == null || state.riskScenario >= n) {
    // Default to the 100-year flood (or the rarest scenario if none reaches it).
    const i = state.risk.scenarios.findIndex((s) => s.rp >= 100);
    state.riskScenario = i < 0 ? n - 1 : i;
  }
  $('risk-status').textContent = `Assessed ${fmt(state.risk.assessed)} buildings and facilities within ${m(P.maxDist)} of ${SOURCES[P.source].label.toLowerCase()} using elevation from ${state.dem.dem.label} (${Math.round(performance.now() - t0)} ms).`;
  if (state.dem.dem.fallback) $('risk-status').innerHTML += ` <span class="warn">${escapeHtml(state.dem.dem.fallback)}.</span>`;
  renderRisk();
  renderFinance();
  $('finance').classList.remove('hidden');
  updateReportChecklist();
}
function renderRisk() {
  const R = state.risk;
  const cur = R.params.currency;
  const worst = R.scenarios[R.scenarios.length - 1];
  const sel = R.scenarios[state.riskScenario];
  let html = `
    <div class="kpis">
      <div class="kpi alert"><b>${money(R.aal, cur)}</b><span>average annual loss (${pctOf(R.aal, R.totalValue)} of value)</span></div>
      <div class="kpi"><b>${money(R.totalValue, cur)}</b><span>total building value in the area</span></div>
      <div class="kpi alert"><b>${fmt(Math.round(R.annualPop))}</b><span>people affected per year on average</span></div>
      <div class="kpi alert"><b>${money(worst.loss, cur)}</b><span>loss in a ${worst.rp}-year flood</span></div>
    </div>
    <div class="sub">Loss-exceedance curve</div>
    <div class="viz" id="loss-chart"></div>
    <table class="list">
      <tr><th>Return period</th><th class="num">Buildings</th><th class="num">People</th><th class="num">Critical</th><th class="num">Loss</th></tr>
      ${R.scenarios.map((s) => `<tr><td>${s.rp}-yr (${s.level} m)</td><td class="num">${fmt(s.buildings)}</td><td class="num">${fmt(Math.round(s.pop))}</td><td class="num">${fmt(s.facilities.length)}</td><td class="num">${money(s.loss, cur)}</td></tr>`).join('')}
    </table>
    <p class="note">Average annual loss assumes no damage below the ${R.scenarios[0].rp}-year flood and the ${worst.rp}-year loss for rarer floods.</p>
    <label class="field" style="margin-top:10px"><span>Show on map</span>
      <select id="risk-scenario">${R.scenarios.map((s, i) => `<option value="${i}" ${i === state.riskScenario ? 'selected' : ''}>${s.rp}-year flood (${s.level} m)</option>`).join('')}</select>
    </label>
    <div class="ramp">${DEPTH_CLASSES.map((c) => `<span style="background:${c.color}" title="${c.label}"></span>`).join('')}</div>
    <div class="row small muted" style="justify-content:space-between">${DEPTH_CLASSES.map((c) => `<span>${c.label}</span>`).join('')}</div>`;
  if (sel.facilities.length) {
    html += `<div class="sub">Critical facilities flooded (${sel.rp}-yr)</div><table class="list">`;
    for (const { p, depth } of sel.facilities.slice(0, 20)) html += row(featureLabel(p), `${depth.toFixed(1)} m`);
    html += '</table>';
    if (sel.facilities.length > 20) html += `<p class="note">…and ${sel.facilities.length - 20} more in the CSV.</p>`;
  }
  const sl = R.slope;
  html += `<div class="sub">Landslide screening (slope)</div><table class="list">
    ${row('Buildings on 15–25° slopes', `${fmt(sl.moderate.count)} · ${fmt(Math.round(sl.moderate.pop))} people`)}
    ${row('Buildings on slopes over 25°', `${fmt(sl.steep.count)} · ${fmt(Math.round(sl.steep.pop))} people`)}
  </table><p class="note">Slopes come from ~30 m elevation data, so treat them as indicative only.</p>`;
  $('risk-results').innerHTML = html + exportsBlock('flood');
  lossCurve($('loss-chart'), R.curve, { fmtMoney: (v) => money(v, cur), fmtCompact: compact });
  $('risk-scenario').addEventListener('change', (e) => {
    state.riskScenario = +e.target.value;
    renderRisk();
  });
  showRiskLayer();
  if (state.sviDone) renderSVI();
}
function showRiskLayer() {
  const i = state.riskScenario;
  const features = [];
  for (const p of state.dataset.buildings) {
    if (!p.depths || p.depths[i] <= 0) continue;
    features.push({ ...p.feature, properties: { fid: p.fid, depth: p.depths[i] } });
  }
  map.getSource('risk').setData({ type: 'FeatureCollection', features });
  refresh3D();
}
export function clearRisk() {
  state.risk = null;
  layerCtrl.setAvailable('depth', false);
  map.getSource('risk')?.setData(EMPTY);
  $('risk-results').innerHTML = '';
  $('risk-status').textContent = '';
  $('finance').classList.add('hidden');
}
$('run-risk').addEventListener('click', runRisk);
// ---- Risk finance ---------------------------------------------------------------------------

export function financeParams() {
  const v = (id, d) => (Number.isFinite(+$(id).value) && +$(id).value > 0 ? +$(id).value : d);
  const ret = v('f-ret', DEFAULT_FINANCE.retentionRP);
  const cred = Math.max(ret, v('f-cred', DEFAULT_FINANCE.creditRP));
  const ins = Math.max(cred, v('f-ins', DEFAULT_FINANCE.transferRP));
  return { retentionRP: ret, creditRP: cred, transferRP: ins, transferMultiple: v('f-mult', 2), creditFeePct: +$('f-fee').value || 0 };
}
function renderFinance() {
  const R = state.risk;
  if (!R) return;
  const cur = R.params.currency;
  const layers = financeLayers(R.curve, financeParams());
  const funded = layers.filter((l) => l.cost != null).reduce((a, l) => a + l.cost, 0);
  let html = `<table class="list">
    <tr><th>Layer</th><th class="num">Covers</th><th class="num">Expected / yr</th><th class="num">Cost / yr</th></tr>`;
  for (const l of layers) {
    const to = Number.isFinite(l.to) ? money(l.to, cur) : '…';
    html += `<tr><td><b>${l.name}</b> · ${l.rp}<br><span class="muted small">${l.instrument}</span></td>
      <td class="num">${money(l.from, cur)}–<br>${to}</td><td class="num">${money(l.eal, cur)}</td>
      <td class="num">${l.cost == null ? '—' : money(l.cost, cur)}<br><span class="muted small">${l.costNote}</span></td></tr>`;
  }
  html += `</table>
    <div class="kpis" style="margin-top:10px">
      <div class="kpi"><b>${money(funded, cur)}</b><span>indicative annual cost of the strategy</span></div>
      <div class="kpi alert"><b>${money(layers[3].eal, cur)}</b><span>expected annual loss left unfunded</span></div>
    </div>
    <p class="note">Indicative screening figures only. Real premiums depend on the market, basis risk and data quality. Layer expected losses add up to the average annual loss.</p>`;
  $('finance-results').innerHTML = html;
}
for (const id of ['f-ret', 'f-cred', 'f-ins', 'f-mult', 'f-fee']) $(id).addEventListener('input', renderFinance);
