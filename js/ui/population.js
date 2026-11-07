// Step 2: population model.

import { BUILDING_CLASSES } from '../osm.js';
import { DEFAULT_POP } from '../analysis.js';
import { $, state } from './shared.js';
import { escapeHtml, fmt, m } from './format.js';
import { probe } from './probe.js';
import { runExposure } from './exposure.js';
import { computeRisk } from './flood.js';
import { runSVI } from './social.js';
import { combineMH } from './multihazard.js';
import { exportsBlock } from './exports.js';

// ---- Population ---------------------------------------------------------------------------

function popParams() {
  return {
    m2PerPerson: Math.max(1, +$('pop-m2').value || DEFAULT_POP.m2PerPerson),
    defaultLevels: Math.max(1, +$('pop-levels').value || 1),
    knownTotal: Math.max(0, +$('pop-known').value || 0),
    knownSource: $('pop-known-source').value,
    knownYear: +$('pop-known-year').value || null,
    unknownResidential: $('pop-unknown').checked,
  };
}
export function applyPopulation() {
  const ds = state.dataset;
  if (!ds) return;
  ds.setPopulation(popParams());
  renderSummary();
  if (state.last) probe(state.last);
  if (state.exposure) runExposure();
  if (state.risk) computeRisk();
  if (state.sviDone) runSVI();
  if (state.mh) combineMH(false);
}
for (const id of ['pop-m2', 'pop-levels', 'pop-known', 'pop-unknown', 'pop-known-source', 'pop-known-year']) $(id).addEventListener('change', applyPopulation);
function renderSummary() {
  const ds = state.dataset;
  const s = ds.summary();
  let html = `
    <div class="kpis">
      <div class="kpi"><b>${fmt(Math.round(s.pop))}</b><span>estimated residents in the area</span></div>
      <div class="kpi"><b>${fmt(s.buildings)}</b><span>buildings · ${fmt(s.facilities)} facilities</span></div>
    </div>`;
  if (ds.popFactor !== 1) {
    const P = ds.popParams;
    const src = [P.knownSource, P.knownYear].filter(Boolean).join(', ');
    html += `<p class="note">Calibrated to your known population${src ? ` (${escapeHtml(src)})` : ''}: the raw estimate was multiplied by ${ds.popFactor.toFixed(2)}.</p>`;
  }
  html += '<table class="list"><tr><th>Building class</th><th class="num">Count</th><th class="num">Residents</th></tr>';
  for (const [k, label] of Object.entries(BUILDING_CLASSES)) {
    const c = s.classes[k];
    if (c) html += `<tr><td>${label}</td><td class="num">${fmt(c.count)}</td><td class="num">${fmt(Math.round(c.pop))}</td></tr>`;
  }
  html += `</table><p class="note">Road network ${m(s.len.road)} · waterways ${m(s.len.water)} inside the area.</p>`;
  $('area-summary').innerHTML = html + exportsBlock('population');
}
