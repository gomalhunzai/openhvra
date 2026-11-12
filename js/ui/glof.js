// Glaciers, glacial lakes, marked features and GLOF outflow paths.

import { ringBBox, lonLatArea } from '../spatial.js';
import { $, state } from './shared.js';
import { escapeHtml, fmt } from './format.js';
import { actions, draw, layerCtrl, map } from './map.js';
import { lakeUploads, runMH } from './multihazard.js';
import { download, stamp } from './exports.js';

// ---- Glaciers, glacial lakes and outflow paths (GLOF) --------------------------------------------

let markSeq = 0;
let cryoCount = 0; // downloaded glaciers and lakes on the map
let markCount = 0; // features marked by the user
let hadCryo = false;

// The layer is available while it has something to show, and switches on when
// it first gets something (unticked again by the layer control when emptied).
function updateCryoLayer() {
  const has = cryoCount + markCount > 0;
  layerCtrl.setAvailable('cryo', has, has && !hadCryo);
  hadCryo = has;
}
const MARK_HINTS = {
  'lake-point': ['point', 'Click the glacial lake. Esc cancels.'],
  'lake-outline': ['polygon', 'Click around the lake shore. Double-click, Enter or click the first point to finish. Esc cancels.'],
  glacier: ['polygon', 'Click around the glacier. Double-click, Enter or click the first point to finish. Esc cancels.'],
};
// Changes whenever lakes or glaciers are added or removed, so the context is refetched.
export function glofInputsKey() {
  return [lakeUploads.length, state.marks.lakes.map((l) => l.id).join(), state.marks.glaciers.map((g) => g.id).join()].join('|');
}
// The user's marked lakes in the form the GLOF model uses.
export function markedLakes() {
  return state.marks.lakes.map((l) => {
    if (l.kind === 'point') return { id: l.id, name: 'Marked lake', lon: l.point[0], lat: l.point[1], area: l.area, source: 'marked by you' };
    const n = l.ring.length - 1;
    return {
      id: l.id, name: 'Marked lake', area: l.area, outline: [l.ring], source: 'marked by you',
      lon: l.ring.slice(0, n).reduce((a, c) => a + c[0], 0) / n, lat: l.ring.slice(0, n).reduce((a, c) => a + c[1], 0) / n,
    };
  });
}
// Puts back marks saved in a project; new marks are numbered after them.
export function restoreMarks(marks) {
  state.marks = marks;
  const ids = [...marks.lakes, ...marks.glaciers].map((x) => +/^mark:(d+)$/.exec(x.id)?.[1] || 0);
  markSeq = Math.max(markSeq, 0, ...ids);
  renderMarks();
}
function startMark(kind, extra = {}) {
  if (draw.mode) draw.cancel(false);
  state.drawPurpose = { kind, ...extra };
  if (kind === 'path') {
    const lake = state.mh?.ctx.lakes.find((l) => l.id === extra.lakeId);
    draw.start('line', `Draw the outflow of ${lake?.name || 'this lake'}: start at the lake and click downstream along the valley. Double-click or Enter to finish.`);
  } else {
    draw.start(...MARK_HINTS[kind]);
  }
}
function addMark(purpose, shape) {
  const id = `mark:${++markSeq}`;
  if (purpose.kind === 'lake-point') {
    state.marks.lakes.push({ id, kind: 'point', point: shape.point, area: Math.max(0.1, +$('mark-area').value || 5) * 1e4 });
  } else if (purpose.kind === 'lake-outline') {
    state.marks.lakes.push({ id, kind: 'outline', ring: shape.ring, area: lonLatArea(shape.ring) });
  } else if (purpose.kind === 'glacier') {
    state.marks.glaciers.push({ id, ring: shape.ring, area: lonLatArea(shape.ring) });
  } else if (purpose.kind === 'path') {
    state.marks.paths[purpose.lakeId] = shape.line;
  }
  renderMarks();
  // A drawn path changes only the tracing, so rerun straight away.
  if (purpose.kind === 'path' && state.mh) runMH();
  else if (state.mh) $('lake-status').textContent = 'Run the multi-hazard analysis again to include your new mark.';
}
function renderMarks() {
  const M = state.marks;
  const lakeName = (id) => state.mh?.ctx.lakes.find((l) => l.id === id)?.name || 'lake';
  const items = [
    ...M.lakes.map((l) => [`lake|${l.id}`, `Lake (${l.kind}, ${(l.area / 1e4).toFixed(1)} ha)`]),
    ...M.glaciers.map((g) => [`glacier|${g.id}`, `Glacier (${(g.area / 1e6).toFixed(2)} km²)`]),
    ...Object.keys(M.paths).map((id) => [`path|${id}`, `Outflow path drawn for ${lakeName(id)}`]),
  ];
  $('mark-list').innerHTML = items.map(([key, label]) =>
    `<li class="done"><span class="mark">✎</span><span class="label">${escapeHtml(label)}</span><button type="button" class="btn mini" data-del="${key}" title="Delete">Delete</button></li>`).join('');
  $('dl-marks').disabled = !items.length;
  map.getSource('cryo-marks')?.setData(marksGeoJSON());
  markCount = items.length;
  updateCryoLayer();
}
function marksGeoJSON() {
  const M = state.marks;
  const f = (geometry, properties) => ({ type: 'Feature', geometry, properties });
  return {
    type: 'FeatureCollection',
    features: [
      ...M.lakes.map((l) => (l.kind === 'point'
        ? f({ type: 'Point', coordinates: l.point }, { kind: 'glacial lake', area_ha: +(l.area / 1e4).toFixed(2), source: 'OpenHVRA mark' })
        : f({ type: 'Polygon', coordinates: [l.ring] }, { kind: 'glacial lake', area_ha: +(l.area / 1e4).toFixed(2), source: 'OpenHVRA mark' }))),
      ...M.glaciers.map((g) => f({ type: 'Polygon', coordinates: [g.ring] }, { kind: 'glacier', area_km2: +(g.area / 1e6).toFixed(3), source: 'OpenHVRA mark' })),
      ...Object.entries(M.paths).map(([id, line]) => f({ type: 'LineString', coordinates: line }, { kind: 'lake outflow path', lake: id, source: 'OpenHVRA mark' })),
    ],
  };
}
// Show downloaded glaciers, lakes and traced paths (null clears them).
export function showCryo(ctx) {
  const fc = (features) => ({ type: 'FeatureCollection', features });
  map.getSource('cryo-glaciers')?.setData(fc(ctx?.glacierFeatures ?? []));
  cryoCount = (ctx?.glacierFeatures?.length ?? 0) + (ctx?.lakes?.length ?? 0);
  updateCryoLayer();
  map.getSource('cryo-lakes')?.setData(fc((ctx?.lakes ?? []).map((l) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
    properties: { id: l.id, name: l.name, area: l.area, elev: Math.round(l.elev ?? 0), reaches: !!l.reaches, method: l.method ?? '', source: l.source },
  }))));
  map.getSource('cryo-paths')?.setData(fc((ctx?.lakes ?? []).filter((l) => l.path?.length > 1).map((l) => ({
    type: 'Feature', geometry: { type: 'LineString', coordinates: l.path }, properties: { id: l.id, reaches: !!l.reaches },
  }))));
}
export function lakeTable(ctx) {
  const lakes = ctx.lakes;
  const reach = lakes.filter((l) => l.reaches).length;
  let html = `<div class="sub">Glacial lakes and outflow paths</div>
    <p class="note">${fmt(ctx.glaciers ?? 0)} glaciers and ${fmt(lakes.length)} glacial lake(s) considered; <b>${reach}</b> drain through your area and are used.
    Paths: purple = reaches your area, grey = drains elsewhere. If a path looks wrong, draw it yourself.</p>
    <div class="table-scroll"><table class="list calc"><tr><th>Lake</th><th class="num">Area (ha)</th><th class="num">Elev. (m)</th><th>Path traced by</th><th class="num">Reaches area</th><th></th></tr>`;
  for (const l of lakes) {
    html += `<tr><td>${escapeHtml(l.name || 'Unnamed lake')}<br><span class="muted small">${escapeHtml(l.source)}</span></td>
      <td class="num">${(l.area / 1e4).toFixed(1)}</td><td class="num">${Number.isFinite(l.elev) ? fmt(Math.round(l.elev)) : '—'}</td>
      <td>${escapeHtml(l.method || 'not traced')}</td>
      <td class="num">${l.reaches ? `yes, ${l.distToAreaKm.toFixed(1)} km` : 'no'}</td>
      <td class="lake-actions"><button type="button" class="linklike" data-lake-zoom="${l.id}">Zoom</button><button type="button" class="linklike" data-lake-path="${l.id}">Draw path</button>${
        state.marks.paths[l.id] ? `<button type="button" class="linklike" data-lake-reset="${l.id}">Use traced path</button>` : ''}</td></tr>`;
  }
  return `${html}</table></div>`;
}
document.addEventListener('click', (e) => {
  const t = e.target;
  const mark = t.closest('[data-mark]')?.dataset.mark;
  if (mark) return startMark(mark);
  const del = t.closest('[data-del]')?.dataset.del;
  if (del) {
    const [kind, id] = del.split('|');
    if (kind === 'lake') state.marks.lakes = state.marks.lakes.filter((l) => l.id !== id);
    if (kind === 'glacier') state.marks.glaciers = state.marks.glaciers.filter((g) => g.id !== id);
    if (kind === 'path') delete state.marks.paths[id];
    renderMarks();
    if (state.mh) $('lake-status').textContent = 'Run the multi-hazard analysis again to apply the change.';
    return;
  }
  const lakeId = t.closest('[data-lake-zoom],[data-lake-path],[data-lake-reset]');
  if (!lakeId || !state.mh) return;
  const { lakeZoom, lakePath, lakeReset } = lakeId.dataset;
  if (lakeZoom) {
    const l = state.mh.ctx.lakes.find((x) => x.id === lakeZoom);
    const pts = l.path?.length ? [[l.lon, l.lat], ...l.path] : [[l.lon, l.lat]];
    const [w, s, ea, n] = ringBBox(pts);
    map.fitBounds([[w, s], [ea, n]], { padding: 60, maxZoom: 14, duration: 900 });
  } else if (lakePath) {
    startMark('path', { lakeId: lakePath });
  } else if (lakeReset) {
    delete state.marks.paths[lakeReset];
    renderMarks();
    runMH();
  }
});
$('dl-marks').addEventListener('click', () => download(`openhvra-glacier-lake-marks-${stamp()}.geojson`, JSON.stringify(marksGeoJSON()), 'application/geo+json'));

Object.assign(actions, { addMark });
