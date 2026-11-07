// Step 4: exposure by distance.

import { CRITICAL_GROUPS } from '../osm.js';
import { SOURCES } from '../analysis.js';
import { $, EMPTY, state } from './shared.js';
import { escapeHtml, featureLabel, fmt, groupTable, m, row } from './format.js';
import { layerCtrl, map, metresToPixels } from './map.js';
import { ensureDEM } from './flood.js';
import { exportsBlock, updateReportChecklist } from './exports.js';

// ---- Exposure by distance -----------------------------------------------------------------

for (const [k, s] of Object.entries(SOURCES)) $('source').add(new Option(s.label, k));
const isWaterSource = () => $('source').value.startsWith('water');
function updateElevationOption() {
  $('elev-opts').classList.toggle('hidden', !isWaterSource());
}
$('source').addEventListener('change', updateElevationOption);
updateElevationOption();
export async function runExposure() {
  const ds = state.dataset;
  if (!ds) return;
  const dist = Math.max(1, Math.min(2000, +$('dist').value || 100));
  const useElev = isWaterSource() && $('use-elev').checked;
  let dem = null;
  if (useElev) {
    $('run').disabled = true;
    try {
      dem = await ensureDEM($('exposure-results'));
    } catch (err) {
      $('exposure-results').innerHTML = `<p class="warn">Elevation unavailable (${escapeHtml(err.message)}); showing distance only.</p>`;
    } finally {
      $('run').disabled = false;
    }
  }
  const maxHeight = Math.max(0, +$('max-height').value || 5);
  const res = ds.exposure($('source').value, dist, { dem, maxHeight });
  state.exposure = res;

  const lat = (ds.bbox[1] + ds.bbox[3]) / 2;
  map.setPaintProperty('buffer', 'line-width', metresToPixels(dist * 2, lat));
  map.getSource('buffer').setData({ type: 'FeatureCollection', features: res.sourceLines.map((l) => l.feature) });
  layerCtrl.setAvailable('exposure', true, true);
  // Flood-exposed in red; steep-bank (erosion) in orange; high-and-stable not drawn.
  map.getSource('exposed').setData({
    type: 'FeatureCollection',
    features: res.all.filter((h) => h.ex !== 'high').map(({ p, ex }) => ({ ...p.feature, properties: { ...p.feature.properties, ex } })),
  });

  const src = SOURCES[res.sourceKey];
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '0');
  let html;
  if (!res.sourceLines.length) {
    html = `<p class="warn">No ${escapeHtml(src.label.toLowerCase())} are mapped in the loaded area.</p>`;
  } else {
    const fac = Object.values(res.groups).reduce((a, b) => a + b, 0);
    html = `
      <div class="kpis">
        <div class="kpi alert"><b>${fmt(Math.round(res.pop))}</b><span>est. residents (${pct(res.pop, res.totals.pop)}%) ${res.elevation ? `flood-exposed: within ${dist} m and ≤ ${res.maxHeight} m above` : `within ${dist} m of`} ${escapeHtml(src.short)}</span></div>
        <div class="kpi alert"><b>${fmt(res.buildings)}</b><span>of ${fmt(res.totals.buildings)} buildings (${pct(res.buildings, res.totals.buildings)}%)</span></div>
        <div class="kpi alert"><b>${fmt(fac)}</b><span>of ${fmt(res.totals.facilities)} facilities</span></div>
        <div class="kpi"><b>${m(res.sourceLength)}</b><span>of ${escapeHtml(src.label.toLowerCase())} in the area</span></div>
      </div>`;
    if (res.elevation) {
      html += `<div class="sub">Within ${dist} m, split by height above the water</div>
        <table class="list"><tr><th></th><th class="num">Buildings</th><th class="num">Residents</th><th class="num">Facilities</th></tr>
        <tr><td><span class="dot" style="background:#e03131"></span>Flood-exposed (≤ ${res.maxHeight} m above)</td><td class="num">${fmt(res.buildings)}</td><td class="num">${fmt(Math.round(res.pop))}</td><td class="num">${fmt(fac)}</td></tr>
        <tr><td><span class="dot" style="background:#f08c00"></span>Steep bank: erosion / undercutting risk</td><td class="num">${fmt(res.bank.buildings)}</td><td class="num">${fmt(Math.round(res.bank.pop))}</td><td class="num">${fmt(res.bank.facilities)}</td></tr>
        <tr><td><span class="dot" style="background:#adb5bd"></span>Higher up on stable ground (not exposed)</td><td class="num">${fmt(res.high.buildings)}</td><td class="num">${fmt(Math.round(res.high.pop))}</td><td class="num">${fmt(res.high.facilities)}</td></tr>
        </table>
        <p class="note">Height is ground elevation at the building minus the channel elevation at its nearest point on the waterway (~30 m elevation data, a few metres' error). "Steep bank" means the ground rises 25° or more from the water to the building.</p>`;
    } else {
      html += '<p class="note">Distances are measured from each feature\'s centre. For rivers and streams, tick "Use elevation" to leave out buildings well above the water.</p>';
    }
    if (fac) {
      html += `<div class="sub">Exposed facilities by type</div>${groupTable(res.groups)}`;
      const critical = res.hits.filter(({ p }) => p.kind === 'facility' && CRITICAL_GROUPS.has(p.group));
      if (critical.length) {
        html += `<div class="sub">Critical facilities at risk</div><table class="list">`;
        for (const { p, d } of critical.slice(0, 25)) html += row(featureLabel(p), `${Math.round(d)} m`);
        html += '</table>';
        if (critical.length > 25) html += `<p class="note">…and ${critical.length - 25} more. Download the CSV for the full list.</p>`;
      }
    }
  }
  $('exposure-results').innerHTML = html + (res.sourceLines.length ? exportsBlock('exposure') : '');
  $('downloads').classList.toggle('hidden', !res.hits.length);
  updateReportChecklist();
}
export function clearExposure() {
  state.exposure = null;
  layerCtrl.setAvailable('exposure', false);
  map.getSource('buffer')?.setData(EMPTY);
  map.getSource('exposed')?.setData(EMPTY);
  $('exposure-results').innerHTML = '';
  $('downloads').classList.add('hidden');
}
$('run').addEventListener('click', runExposure);
$('clear').addEventListener('click', clearExposure);
