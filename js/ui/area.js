// Step 1: area of interest, uploaded boundary files and loading OSM data.

import { loadOSM, clearCache } from '../osm.js';
import { Dataset } from '../analysis.js';
import { ringBBox, lonLatArea, bboxAreaKm2 } from '../spatial.js';
import { setElevationSource } from '../elevation.js';
import { readSpatialFiles, toAoiPolygons, polygonFeatures, featureLabel as fileFeatureName, ACCEPT } from '../upload.js';
import { $, EMPTY, MAX_AREA_KM2, state } from './shared.js';
import { escapeHtml, fmt, m } from './format.js';
import { actions, draw, drawCtrl, map } from './map.js';
import { applyPopulation } from './population.js';
import { probe } from './probe.js';
import { clearExposure } from './exposure.js';
import { clearRisk, fillCosts } from './flood.js';
import { clearSVI } from './social.js';
import { clearMH } from './multihazard.js';
import { updateReportChecklist } from './exports.js';
import { refresh3D } from './view3d.js';
import { clearCompleteness, runCompleteness } from './completeness.js';

// ---- Area of interest ------------------------------------------------------------------

function setHint(text) {
  let el = document.querySelector('.draw-hint');
  if (!text) return el?.remove();
  if (!el) {
    el = Object.assign(document.createElement('div'), { className: 'draw-hint' });
    $('map').appendChild(el);
  }
  el.textContent = text;
}
function startDraw(mode) {
  if (mode === 'view') return setAoi(null);
  if (draw.mode === mode) {
    draw.cancel();
    return;
  }
  drawCtrl.setActive(mode);
  draw.start(mode);
}
// `shape` is a drawn shape ({ type, ring, ... }) or an upload ({ type: 'upload',
// polygons, name }); both are stored with `polygons` as [[outer, ...holes], ...].
function setAoi(shape) {
  draw.cancel(false);
  if (shape?.type !== 'upload') $('upload-feature').classList.add('hidden');
  state.aoi = shape && { ...shape, polygons: shape.polygons ?? [[shape.ring]] };
  map.getSource('aoi')?.setData(state.aoi ? { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: state.aoi.polygons } } : EMPTY);
  updateAoiInfo();
}
export function aoiArea(polygons) {
  return polygons.reduce((a, [outer, ...holes]) => a + lonLatArea(outer) - holes.reduce((h, r) => h + lonLatArea(r), 0), 0);
}
function currentBBox() {
  if (state.aoi) return ringBBox(state.aoi.polygons.map((p) => p[0]).flat()).map((v) => +v.toFixed(6));
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => +v.toFixed(6));
}
function buildingDetail() {
  return document.querySelector('input[name=bdetail]:checked').value;
}
function updateAoiInfo() {
  const bbox = currentBBox();
  const box = bboxAreaKm2(bbox);
  const limit = MAX_AREA_KM2[buildingDetail()];
  const names = { rect: 'Rectangle', circle: 'Circle', polygon: 'Polygon', upload: 'Uploaded area' };
  let text;
  if (state.aoi) {
    const area = aoiArea(state.aoi.polygons) / 1e6;
    text = `<b>${names[state.aoi.type]}</b>${state.aoi.name ? ` (${escapeHtml(state.aoi.name)})` : ''}: ${area.toFixed(2)} km²`;
    if (state.aoi.radius) text += ` (radius ${m(state.aoi.radius)})`;
    if (state.aoi.usedBBox) text += '. The file had no polygons, so its bounding box is used.';
  } else if (box > limit * 20) {
    // Far too large to be a plausible area (e.g. the initial world view): guide rather than warn.
    text = `Search for a place or zoom in to your area of interest, then draw an area or use the view (up to ${limit} km²).`;
  } else {
    text = `<b>Current map view</b>: ${box.toFixed(1)} km²`;
  }
  const tooBig = box > limit;
  if (tooBig && (state.aoi || box <= limit * 20)) text += ` <span class="warn">Too large: max ${limit} km² in ${buildingDetail()} mode. Zoom in or draw a smaller area.</span>`;
  $('aoi-info').innerHTML = text;
  $('load').disabled = tooBig;
  document.querySelectorAll('[data-draw]').forEach((b) => b.classList.toggle('active', b.dataset.draw === (state.aoi?.type ?? 'view')));
}
map.on('moveend', () => {
  if (!state.aoi) updateAoiInfo();
});
document.querySelectorAll('[data-draw]').forEach((b) => b.addEventListener('click', () => startDraw(b.dataset.draw)));
// ---- Uploaded boundary files ---------------------------------------------------------------

const upload = { features: [], format: '' };
$('upload-file').accept = ACCEPT;
async function handleUpload(files) {
  if (!files?.length) return;
  if (files.length === 1 && /.openhvra$/i.test(files[0].name)) return actions.openProjectFile(files[0]);
  const label = [...files].map((f) => f.name).join(', ');
  $('aoi-info').innerHTML = `Reading <b>${escapeHtml(label)}</b>…`;
  try {
    const { features, format } = await readSpatialFiles(files);
    const polys = polygonFeatures(features);
    upload.features = polys.length ? polys : features;
    upload.format = format;
    const sel = $('upload-feature');
    if (polys.length > 1) {
      sel.innerHTML = `<option value="all">All ${polys.length} areas in the file</option>` +
        polys.slice(0, 1000).map((f, i) => `<option value="${i}">${escapeHtml(fileFeatureName(f, i))}</option>`).join('');
      sel.classList.remove('hidden');
    } else {
      sel.classList.add('hidden');
    }
    selectUploaded('all');
    setStatus(`Read ${fmt(features.length)} feature${features.length === 1 ? '' : 's'} from ${escapeHtml(label)} (${format}).` +
      (polys.length > 1 ? ' Pick one area from the list, or keep all of them.' : ''));
  } catch (err) {
    $('aoi-info').innerHTML = `<span class="warn">Could not read ${escapeHtml(label)}: ${escapeHtml(err.message)}</span>`;
  } finally {
    $('upload-file').value = '';
  }
}
function selectUploaded(value) {
  const feats = value === 'all' ? upload.features : [upload.features[+value]];
  const { polygons, usedBBox } = toAoiPolygons(feats);
  const name = value === 'all' ? (feats.length === 1 ? fileFeatureName(feats[0], 0) : `${feats.length} areas`) : fileFeatureName(feats[0], +value);
  setAoi({ type: 'upload', polygons, name, usedBBox });
  const [w, s, e, n] = currentBBox();
  map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 800, maxZoom: 17 });
}
$('upload-file').addEventListener('change', (e) => handleUpload(e.target.files));
$('upload-feature').addEventListener('change', (e) => selectUploaded(e.target.value));
// Drag and drop a file anywhere on the map.
const mapEl = $('map');
mapEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  mapEl.classList.add('dropping');
});
mapEl.addEventListener('dragleave', (e) => {
  if (!mapEl.contains(e.relatedTarget)) mapEl.classList.remove('dropping');
});
mapEl.addEventListener('drop', (e) => {
  e.preventDefault();
  mapEl.classList.remove('dropping');
  handleUpload(e.dataTransfer.files);
});
document.querySelectorAll('input[name=bdetail]').forEach((r) => r.addEventListener('change', updateAoiInfo));
// Elevation source for all analyses. Results already shown keep the elevation
// they used (and say so in exports) until a step is run again.
$('elev-source').addEventListener('change', (e) => setElevationSource(e.target.value));
setElevationSource($('elev-source').value);
// ---- Loading data -------------------------------------------------------------------------

export function setStatus(html, isError = false) {
  const el = $('status');
  el.innerHTML = html;
  el.classList.toggle('warn', isError);
}
// Downloads the OSM data for the area. When reopening a project, `restore`
// says what was added to it, and the promise waits for the completeness check.
async function loadData({ restore = null } = {}) {
  const bbox = currentBBox();
  const opts = {
    buildings: $('dl-buildings').checked ? buildingDetail() : 'none',
    facilities: $('dl-facilities').checked,
    waterways: $('dl-waterways').checked,
    roads: $('dl-roads').checked,
    paths: $('dl-paths').checked,
  };
  state.abort?.abort();
  state.abort = new AbortController();
  $('load').disabled = true;
  $('progress').classList.remove('hidden');
  const parts = {};
  const names = { buildings: 'Buildings', network: 'Roads, waterways & facilities' };
  const t0 = performance.now();
  try {
    const parsed = await loadOSM(bbox, opts, {
      signal: state.abort.signal,
      onProgress: (part, s) => {
        parts[part] = s.cached ? 'from cache'
          : s.retryIn ? `servers busy, retrying in ${s.retryIn}s…`
          : s.bytes ? `${(s.bytes / 1e6).toFixed(1)} MB received`
          : `waiting for ${s.host}…`;
        setStatus(Object.entries(parts).map(([k, v]) => `${names[k]}: ${v}`).join('<br>'));
      },
    });
    state.loadOpts = opts;
    state.loadedAt = new Date().toISOString();
    state.loadedAoi = state.aoi;
    state.dem = null;
    state.osmParsed = parsed; // as downloaded, before any added buildings or facilities
    const ds = useDataset(parsed, bbox);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`Loaded ${fmt(ds.buildings.length)} buildings, ${fmt(ds.facilities.length)} facilities, ${fmt(parsed.roads.length)} road and ${fmt(parsed.waterways.length)} waterway lines in ${secs}s.` +
      (opts.buildings === 'light' ? ' Building areas are estimated from bounding boxes.' : ''));
    if ($('dl-completeness').checked && (opts.buildings !== 'none' || opts.facilities)) {
      const check = runCompleteness(ds, state.abort.signal, { restore }).then(updateReportChecklist);
      if (restore) await check;
    }
    return true;
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`Could not load data: ${escapeHtml(err.message)}. The public servers may be busy, so try again shortly or load a smaller area.`, true);
    return false;
  } finally {
    $('progress').classList.add('hidden');
    updateAoiInfo();
  }
}
// Uses OSM data saved in a project file instead of downloading it, so the
// project opens exactly as it was saved (also offline).
async function useSavedData(data) {
  state.abort?.abort();
  state.abort = new AbortController();
  state.loadOpts = data.loadOpts;
  state.loadedAt = data.downloadedAt || null;
  state.loadedAoi = state.aoi;
  state.dem = null;
  state.osmParsed = data.osm;
  const ds = useDataset(data.osm, data.bbox);
  const when = data.downloadedAt ? ` downloaded on ${escapeHtml(data.downloadedAt.slice(0, 10))}` : '';
  setStatus(`Using the data saved in the project${when}: ${fmt(ds.buildings.length)} buildings, ${fmt(ds.facilities.length)} facilities, ${fmt(data.osm.roads.length)} road and ${fmt(data.osm.waterways.length)} waterway lines. Press <b>Load OSM data</b> to download the latest instead.`);
  updateAoiInfo();
  if ($('dl-completeness').checked && (data.loadOpts.buildings !== 'none' || data.loadOpts.facilities)) {
    await runCompleteness(ds, state.abort.signal, { restore: data.added ?? {} });
    updateReportChecklist();
  }
  return ds;
}
// Makes `parsed` the data of every step: map layers and population, with
// steps 4–7 cleared (they must be run again). Used on loading, and when
// buildings from other sources are added or removed.
function useDataset(parsed, bbox, { keepChecks = false } = {}) {
    const ds = new Dataset(parsed, bbox, state.loadedAoi?.polygons);
    state.dataset = ds;
    state.byFid = new Map(ds.points.map((p) => [p.fid, p]));
    map.getSource('buildings').setData({ type: 'FeatureCollection', features: ds.buildings.map((p) => p.feature) });
    map.getSource('facilities').setData({ type: 'FeatureCollection', features: ds.facilities.map((p) => p.feature) });
    map.getSource('roads').setData({ type: 'FeatureCollection', features: parsed.roads });
    map.getSource('waterways').setData({ type: 'FeatureCollection', features: parsed.waterways });
    const [w, s, e, n] = bbox;
    map.getSource('bbox').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] } });
    if (!keepChecks) clearCompleteness();
    clearExposure();
    clearRisk();
    clearSVI();
    clearMH();
    $('run-mh').disabled = false;
    $('run-svi').disabled = false;
    $('wb-fetch').disabled = false;
    $('run').disabled = false;
    $('run-risk').disabled = false;
    $('cost-fetch').disabled = $('cost-source').value === 'own';
    // Look costs up once per area, so costs edited by the user (or restored
    // from a project) are kept when buildings are added or removed.
    if (state.costInfo.areaKey !== bbox.join()) fillCosts();
    applyPopulation();
    updateReportChecklist();
    refresh3D();
    if (state.last) probe(state.last);
    return ds;
}
// Removes the loaded data and every result (before opening a project).
function resetData() {
  state.abort?.abort();
  state.dataset = null;
  state.osmParsed = null;
  state.loadOpts = null;
  state.loadedAt = null;
  state.loadedAoi = null;
  state.dem = null;
  state.byFid = new Map();
  for (const id of ['buildings', 'facilities', 'roads', 'waterways', 'bbox']) map.getSource(id)?.setData(EMPTY);
  clearCompleteness();
  clearExposure();
  clearRisk();
  clearSVI();
  clearMH();
  for (const id of ['run-mh', 'run-svi', 'wb-fetch', 'run', 'run-risk', 'cost-fetch']) $(id).disabled = true;
  setStatus('');
  updateReportChecklist();
  refresh3D();
}
$('load').addEventListener('click', () => loadData());
$('clear-cache').addEventListener('click', async (e) => {
  e.preventDefault();
  await clearCache();
  setStatus('Download cache cleared.');
});

Object.assign(actions, { setHint, setAoi, startDraw, updateAoiInfo, useDataset, loadData, useSavedData, currentBBox, resetData });
