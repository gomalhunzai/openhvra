// Step 3: cursor probe and hover tooltips.

import { FACILITY_GROUPS, BUILDING_CLASSES } from '../osm.js';
import { circlePolygon } from '../spatial.js';
import { SVI_CLASSES, sviClass } from '../social.js';
import { HAZARDS } from '../hazards.js';
import { $, EMPTY, state } from './shared.js';
import { escapeHtml, featureLabel, fmt, groupTable, lineName, m, money, nearestText, pretty, row } from './format.js';
import { draw, map } from './map.js';

// ---- Cursor probe -------------------------------------------------------------------------

export function probe(lngLat) {
  state.last = lngLat;
  const { lng, lat } = lngLat;
  const r = state.radius;
  map.getSource('probe')?.setData(circlePolygon(lng, lat, r));
  const ds = state.dataset;
  if (!ds) return;
  if (!ds.contains(lng, lat)) {
    $('probe-stats').innerHTML = '<p class="muted">The cursor is outside the loaded area. Load data for this area to analyse it.</p>';
    map.getSource('probe-hits').setData(EMPTY);
    map.getSource('probe-links').setData(EMPTY);
    return;
  }
  const res = ds.probe(lng, lat, r);
  map.getSource('probe-hits').setData({
    type: 'FeatureCollection',
    features: res.hits.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p.feature.center } })),
  });
  const links = [];
  for (const [kind, n] of [['water', res.nearestWater], ['road', res.nearestRoad]]) {
    if (n) links.push({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: [[lng, lat], n.lonlat] } });
  }
  map.getSource('probe-links').setData({ type: 'FeatureCollection', features: links });

  let html = `
    <div class="kpis">
      <div class="kpi"><b>${fmt(Math.round(res.pop))}</b><span>est. residents within ${r} m</span></div>
      <div class="kpi"><b>${fmt(res.buildings)}</b><span>buildings within ${r} m</span></div>
      <div class="kpi"><b>${nearestText(res.nearestWater)}</b><span>to nearest waterway</span></div>
      <div class="kpi"><b>${nearestText(res.nearestRoad)}</b><span>to nearest major road</span></div>
    </div>
    <table class="list">
      ${row('Facilities in circle', fmt(res.facilities.length))}
      ${row('Road length (major / minor / paths)', `${m(res.roadLen.major)} / ${m(res.roadLen.minor)} / ${m(res.roadLen.path)}`)}
      ${row('Waterway length (rivers / streams)', `${m(res.waterLen.river)} / ${m(res.waterLen.stream)}`)}
      ${state.dem && res.nearestWater ? row('Height above nearest waterway', heightAbove(lng, lat, res.nearestWater)) : ''}
      ${row('Nearest river or canal', res.nearestRiver ? `${lineName(res.nearestRiver.line)} · ${nearestText(res.nearestRiver)}` : '—')}
    </table>`;
  if (res.facilities.length) {
    html += `<div class="sub">Facilities by type</div>${groupTable(res.groups)}<div class="sub">Closest facilities</div><table class="list">`;
    for (const { p, d } of res.facilities.slice(0, 8)) html += row(featureLabel(p), `${Math.round(d)} m`);
    html += '</table>';
  }
  $('probe-stats').innerHTML = html;
}
function heightAbove(lng, lat, n) {
  const dem = state.dem.dem;
  const h = dem.elev(lng, lat) - dem.minAround(n.lonlat[0], n.lonlat[1]);
  return Number.isFinite(h) ? `${Math.max(0, h).toFixed(1)} m` : '—';
}
let raf = 0;
let pending = null;
function schedule(e) {
  pending = e;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!state.pinned && !draw.mode && pending.lngLat) probe(pending.lngLat);
    if (pending.point) hover(pending.point);
  });
}
map.on('mousemove', (e) => schedule(e));
map.on('click', (e) => {
  if (draw.mode || draw.lastHandled === e.originalEvent) return;
  state.pinned = !state.pinned;
  probe(e.lngLat);
  $('pin-hint').textContent = state.pinned
    ? 'Probe pinned. Click the map again to release it.'
    : 'Move the mouse to probe. Click the map to pin or unpin the probe.';
});
$('radius').addEventListener('input', (e) => {
  state.radius = +e.target.value;
  $('radius-out').textContent = `${state.radius} m`;
  if (state.last) probe(state.last);
});
// ---- Hover tooltips (feature identity beyond colour) ----------------------------------------

const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: '260px' });
const HOVER_LAYERS = ['facilities', 'risk-pt', 'risk-fill', 'mh-pt', 'mh-fill', 'svi-pt', 'svi-fill', 'buildings-pt', 'buildings-fill'];
function hover(point) {
  if (draw.mode || !state.dataset) return popup.remove();
  const lake = map.getLayer('cryo-lakes') && map.getLayoutProperty('cryo-lakes', 'visibility') !== 'none' && map.queryRenderedFeatures(point, { layers: ['cryo-lakes'] })[0];
  if (lake) {
    const q = lake.properties;
    popup.setLngLat(map.unproject(point)).setHTML(`<b>${escapeHtml(q.name || 'Glacial lake')}</b><br>${(q.area / 1e4).toFixed(1)} ha · ${q.elev} m · ${escapeHtml(q.source)}<br>${q.reaches ? 'Drains through your area' : 'Drains elsewhere: not used'}${q.method ? `<br>Path: ${escapeHtml(q.method)}` : ''}`).addTo(map);
    return;
  }
  const layers = HOVER_LAYERS.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
  const f = map.queryRenderedFeatures(point, { layers })[0];
  const p = f && state.byFid.get(f.properties.fid);
  if (!p) return popup.remove();
  popup.setLngLat(map.unproject(point)).setHTML(tooltipHTML(p)).addTo(map);
}
function tooltipHTML(p) {
  const title = p.name ? `<b>${escapeHtml(p.name)}</b><br>` : '';
  if (p.kind === 'facility') {
    let h = `${title}${escapeHtml(pretty(p.type))}<br><span style="color:#66707a">${FACILITY_GROUPS[p.group].label}</span>`;
    if (state.risk && p.depths) h += `<br>Flood depth (${state.risk.scenarios[state.riskScenario].rp}-yr): ${p.depths[state.riskScenario].toFixed(1)} m`;
    return h;
  }
  let h = `${title}${BUILDING_CLASSES[p.cls]} · ${escapeHtml(pretty(p.type))}<br>${p.levels ?? `${p.floors} (assumed)`} storey(s) · ${fmt(Math.round(p.footprint))} m² footprint<br>Est. residents: ${p.pop.toFixed(1)}`;
  if (state.risk) {
    const cur = state.risk.params.currency;
    h += `<br>Value: ${money(p.value, cur)}`;
    if (p.hand != null) h += `<br>Height above river: ${p.hand.toFixed(1)} m<br>Depth (${state.risk.scenarios[state.riskScenario].rp}-yr): ${p.depths[state.riskScenario].toFixed(1)} m · loss ${money(p.losses[state.riskScenario], cur)}`;
  }
  if (state.mh && p.hz) {
    const parts = state.mh.keys.filter((k) => (p.hz[k] ?? 0) >= 0.2).map((k) => `${HAZARDS[k].short} ${p.hz[k].toFixed(2)}`);
    h += `<br>Multi-hazard: ${p.mhi.toFixed(2)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    if (p.risk != null) h += `<br>Combined risk: ${p.risk.toFixed(2)}`;
  }
  if (state.sviDone && p.svi != null) {
    h += `<br>Social vulnerability: ${p.svi.toFixed(2)} (${SVI_CLASSES[p.sviClass ?? sviClass(p.svi)].label}${state.sviDone.mode === 'relative' ? ' for this area' : ''})`;
  }
  return h;
}
$('map').addEventListener('mouseleave', () => popup.remove());
