import { loadOSM, clearCache, FACILITY_GROUPS, CRITICAL_GROUPS, BUILDING_CLASSES } from './osm.js';
import { Dataset, SOURCES, DEFAULT_POP } from './analysis.js';
import { circlePolygon, ringBBox, lonLatArea, bboxAreaKm2 } from './spatial.js';
import { loadDEM, floodRisk, financeLayers, expectedAnnual, DEFAULT_SCENARIOS, DEFAULT_COSTS, DEFAULT_FINANCE } from './risk.js';
import { DrawTool } from './draw.js';
import { DrawControl, LayerControl } from './controls.js';
import { lossCurve } from './chart.js';
import { VERSION, REPO } from './version.js';
import { figuresFor } from './figures.js';
import { svgToPng } from './pubcharts.js';
import { renderMapLayout } from './mapexport.js';
import { buildPackage, buildingsCSV, facilitiesCSV, matrixCSV, STEPS, stepCSV, stepGeoJSON } from './report.js';
import { readSpatialFiles, toAoiPolygons, polygonFeatures, featureLabel as fileFeatureName, ACCEPT } from './upload.js';
import { SVI_INDICATORS, SVI_CLASSES, GROUPS, DEFAULT_SHARES, sviClass, fetchCountryShares, groupCounts, prepareCensus, computeSVI, classifySVI, sviSummary } from './social.js';
import { HAZARDS, HIGH, NOISE_FLOOR, LIKELIHOOD, IMPACT, IMPACT_STEPS, rating, SCORE_CLASSES, scoreClass, loadHazardContext, lakesFromFeatures, scoreHazards, combine, riskMatrix } from './hazards.js';

const MAX_AREA_KM2 = { light: 60, footprints: 25 };
const EMPTY = { type: 'FeatureCollection', features: [] };
const $ = (id) => document.getElementById(id);
// Sequential blue ramp (ordinal steps 250→700) for flood depth classes.
const DEPTH_CLASSES = [
  { max: 0.5, color: '#86b6ef', label: '< 0.5 m' },
  { max: 1, color: '#5598e7', label: '0.5–1 m' },
  { max: 2, color: '#2a78d6', label: '1–2 m' },
  { max: 3, color: '#1c5cab', label: '2–3 m' },
  { max: Infinity, color: '#0d366b', label: '> 3 m' },
];

const state = {
  dataset: null,
  aoi: null, // selected area { type, polygons, name?, radius? } or null for the current view
  radius: 100,
  pinned: false,
  last: null,
  exposure: null,
  risk: null,
  sviDone: null, // { use, census, ms } once social vulnerability is computed
  riskScenario: null, // index of the scenario shown on the map
  dem: null, // { key, dem }
  abort: null,
  byFid: new Map(),
};

// ---- Map ----------------------------------------------------------------------------

const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const BASEMAPS = {
  osm: { label: 'OpenStreetMap', swatch: '#f2efe9', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: OSM_ATTR, maxzoom: 19, paint: { 'raster-saturation': -0.6, 'raster-opacity': 0.85 } },
  hot: { label: 'Humanitarian (HOT)', swatch: '#f4e3c9', tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png`), attribution: `${OSM_ATTR}, style by <a href="https://www.hotosm.org/">HOT</a>, hosted by OSM France`, maxzoom: 19, paint: { 'raster-saturation': -0.3 } },
  light: { label: 'Light (CARTO)', swatch: '#f5f5f3', tiles: ['a', 'b', 'c'].map((s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png`), attribution: `${OSM_ATTR} © <a href="https://carto.com/attributions">CARTO</a>`, maxzoom: 20 },
  topo: { label: 'Topographic', swatch: '#cfe0b4', tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`), attribution: `${OSM_ATTR}, SRTM | style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`, maxzoom: 17 },
  sat: { label: 'Satellite (Esri)', swatch: '#3d5a3a', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Imagery © Esri, Maxar, Earthstar Geographics', maxzoom: 19 },
};

const style = { version: 8, sources: {}, layers: [] };
for (const [id, b] of Object.entries(BASEMAPS)) {
  style.sources[`base-${id}`] = { type: 'raster', tileSize: 256, tiles: b.tiles, attribution: b.attribution, maxzoom: b.maxzoom };
  style.layers.push({ id: `base-${id}`, type: 'raster', source: `base-${id}`, layout: { visibility: id === 'osm' ? 'visible' : 'none' }, paint: b.paint ?? {} });
}

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [20, 15], // global view
  zoom: 1.5,
  hash: true,
  attributionControl: { compact: false },
});

const draw = new DrawTool(map, {
  onFinish: (shape) => {
    drawCtrl.setActive(null);
    setHint(null);
    setAoi(shape);
  },
  onHint: (text) => {
    setHint(text);
    if (!text) drawCtrl.setActive(null);
  },
});
const drawCtrl = new DrawControl({ onDraw: startDraw, onClear: () => setAoi(null), onUpload: () => $('upload-file').click() });
map.addControl(drawCtrl, 'top-left');
map.addControl(new maplibregl.NavigationControl(), 'top-right');
const ramp = (classes) => classes.map((c) => ({ label: c.label, color: c.color }));
const layerCtrl = new LayerControl({
  basemaps: BASEMAPS,
  basemap: 'osm',
  layers: [
    { key: 'area', label: 'Selected area', ids: ['aoi-fill', 'aoi-line', 'bbox'], symbol: { kind: 'line', color: '#7048e8' } },
    { key: 'buildings', label: 'Buildings', ids: ['buildings-fill', 'buildings-line', 'buildings-pt'], symbol: { kind: 'fill', color: '#5c6b7a' } },
    { key: 'roads', label: 'Roads', ids: ['roads'], symbol: { kind: 'line', color: '#f59f00' },
      items: [{ label: 'Major road', color: '#f59f00' }, { label: 'Other road', color: '#868e96' }, { label: 'Footpath', color: '#adb5bd' }] },
    { key: 'waterways', label: 'Waterways', ids: ['waterways'], symbol: { kind: 'line', color: '#1c7ed6' } },
    { key: 'facilities', label: 'Facilities', ids: ['facilities'], symbol: { kind: 'dot', color: '#e34948' },
      items: Object.values(FACILITY_GROUPS).map((g) => ({ label: g.label, color: g.color })) },
    { key: 'probe', label: 'Cursor probe', ids: ['probe-fill', 'probe-line', 'probe-hits', 'probe-links'], symbol: { kind: 'dot', color: '#ffd43b' } },
    { key: 'exposure', label: 'Exposure (step 4)', ids: ['buffer', 'exposed-fill', 'exposed-pt'], symbol: { kind: 'fill', color: '#e03131' }, available: false,
      hint: 'Run step 4 to show', items: [{ label: 'Flood-exposed', color: '#e03131' }, { label: 'Steep riverbank (erosion)', color: '#f08c00' }, { label: 'Distance buffer', color: '#fcc2c2' }] },
    { key: 'depth', label: 'Flood depth (step 5)', ids: ['risk-fill', 'risk-pt'], symbol: { kind: 'fill', color: '#2a78d6' }, available: false, exclusive: 'colour',
      hint: 'Run step 5 to show', ramp: ramp(DEPTH_CLASSES) },
    { key: 'svi', label: 'Social vulnerability (step 6)', ids: ['svi-fill', 'svi-pt'], symbol: { kind: 'fill', color: '#b8481b' }, available: false, exclusive: 'colour',
      hint: 'Run step 6 to show', ramp: ramp(SVI_CLASSES) },
    { key: 'mh', label: 'Multi-hazard / risk (step 7)', ids: ['mh-fill', 'mh-pt'], symbol: { kind: 'fill', color: '#ad2b2b' }, available: false, exclusive: 'colour',
      hint: 'Run step 7 to show', ramp: ramp(SCORE_CLASSES) },
  ],
});
map.addControl(layerCtrl, 'bottom-left');
map.addControl(new maplibregl.GeolocateControl({ fitBoundsOptions: { maxZoom: 15 } }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const groupColor = ['match', ['get', 'group']];
for (const [g, def] of Object.entries(FACILITY_GROUPS)) if (g !== 'other') groupColor.push(g, def.color);
groupColor.push(FACILITY_GROUPS.other.color);

const depthColor = ['step', ['get', 'depth'], DEPTH_CLASSES[0].color];
DEPTH_CLASSES.slice(0, -1).forEach((c, i) => depthColor.push(c.max, DEPTH_CLASSES[i + 1].color));

const sviColor = ['match', ['get', 'cls']];
SVI_CLASSES.forEach((c, i) => sviColor.push(i, c.color));
sviColor.push(SVI_CLASSES[0].color);

const mhColor = ['step', ['get', 'v'], SCORE_CLASSES[0].color];
SCORE_CLASSES.slice(0, -1).forEach((c, i) => mhColor.push(c.max, SCORE_CLASSES[i + 1].color));

const exposedColor = ['match', ['get', 'ex'], 'bank', '#f08c00', '#e03131'];

// Width in pixels that makes a line `metres` wide on the ground at this latitude.
function metresToPixels(metres, lat) {
  const w0 = (metres * 512) / (40075016.686 * Math.cos((lat * Math.PI) / 180));
  return ['interpolate', ['exponential', 2], ['zoom'], 0, w0, 22, w0 * 2 ** 22];
}

map.on('load', () => {
  for (const id of ['aoi', 'buildings', 'roads', 'waterways', 'facilities', 'buffer', 'exposed', 'svi', 'mh', 'risk', 'bbox', 'probe', 'probe-hits', 'probe-links']) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  const isPoint = ['==', ['geometry-type'], 'Point'];
  const ptRadius = ['interpolate', ['linear'], ['zoom'], 13, 1.5, 16, 3, 18, 5];
  map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#7048e8', 'fill-opacity': 0.05 } });
  map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#7048e8', 'line-width': 2 } });
  map.addLayer({ id: 'bbox', type: 'line', source: 'bbox', paint: { 'line-color': '#495057', 'line-width': 1.2, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'buffer', type: 'line', source: 'buffer', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fa5252', 'line-opacity': 0.18, 'line-width': 1 } });
  map.addLayer({ id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
    'line-color': ['match', ['get', 'cls'], 'major', '#f59f00', 'path', '#adb5bd', '#868e96'],
    'line-width': ['interpolate', ['linear'], ['zoom'], 13, ['match', ['get', 'cls'], 'major', 2, 0.6], 18, ['match', ['get', 'cls'], 'major', 8, 'path', 1.5, 4]],
  } });
  map.addLayer({ id: 'waterways', type: 'line', source: 'waterways', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
    'line-color': '#1c7ed6',
    'line-width': ['interpolate', ['linear'], ['zoom'], 13, ['match', ['get', 'cls'], 'river', 2.5, 1], 18, ['match', ['get', 'cls'], 'river', 9, 4]],
  } });
  map.addLayer({ id: 'buildings-fill', type: 'fill', source: 'buildings', filter: ['!', isPoint], paint: { 'fill-color': '#5c6b7a', 'fill-opacity': 0.35 } });
  map.addLayer({ id: 'buildings-line', type: 'line', source: 'buildings', filter: ['!', isPoint], minzoom: 15, paint: { 'line-color': '#4a5663', 'line-width': 0.6 } });
  map.addLayer({ id: 'buildings-pt', type: 'circle', source: 'buildings', filter: isPoint, paint: { 'circle-radius': ptRadius, 'circle-color': '#5c6b7a', 'circle-opacity': 0.7 } });
  map.addLayer({ id: 'exposed-fill', type: 'fill', source: 'exposed', filter: ['!', isPoint], paint: { 'fill-color': exposedColor, 'fill-opacity': 0.75 } });
  map.addLayer({ id: 'svi-fill', type: 'fill', source: 'svi', filter: ['!', isPoint], paint: { 'fill-color': sviColor, 'fill-opacity': 0.9 } });
  map.addLayer({ id: 'svi-pt', type: 'circle', source: 'svi', filter: isPoint, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 18, 7], 'circle-color': sviColor } });
  map.addLayer({ id: 'mh-fill', type: 'fill', source: 'mh', filter: ['!', isPoint], paint: { 'fill-color': mhColor, 'fill-opacity': 0.9 } });
  map.addLayer({ id: 'mh-pt', type: 'circle', source: 'mh', filter: isPoint, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 18, 7], 'circle-color': mhColor } });
  map.addLayer({ id: 'risk-fill', type: 'fill', source: 'risk', filter: ['!', isPoint], paint: { 'fill-color': depthColor, 'fill-opacity': 0.9 } });
  map.addLayer({ id: 'risk-pt', type: 'circle', source: 'risk', filter: isPoint, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 18, 7], 'circle-color': depthColor } });
  map.addLayer({ id: 'facilities', type: 'circle', source: 'facilities', paint: {
    'circle-color': groupColor, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 18, 7],
    'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
  } });
  map.addLayer({ id: 'exposed-pt', type: 'circle', source: 'exposed', filter: isPoint, paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 5, 18, 10], 'circle-color': 'rgba(0,0,0,0)',
    'circle-stroke-color': exposedColor, 'circle-stroke-width': 2.5,
  } });
  map.addLayer({ id: 'probe-fill', type: 'fill', source: 'probe', paint: { 'fill-color': '#0b6bcb', 'fill-opacity': 0.08 } });
  map.addLayer({ id: 'probe-line', type: 'line', source: 'probe', paint: { 'line-color': '#0b6bcb', 'line-width': 2 } });
  map.addLayer({ id: 'probe-hits', type: 'circle', source: 'probe-hits', paint: {
    'circle-radius': 3.5, 'circle-color': '#ffd43b', 'circle-stroke-color': '#1d2329', 'circle-stroke-width': 1,
  } });
  map.addLayer({ id: 'probe-links', type: 'line', source: 'probe-links', paint: {
    'line-color': ['match', ['get', 'kind'], 'water', '#1c7ed6', '#f08c00'], 'line-width': 2, 'line-dasharray': [2, 1.5],
  } });
  draw.addLayers();
  updateAoiInfo();
});

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

function aoiArea(polygons) {
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

// ---- Loading data -------------------------------------------------------------------------

function setStatus(html, isError = false) {
  const el = $('status');
  el.innerHTML = html;
  el.classList.toggle('warn', isError);
}

async function loadData() {
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
    const ds = new Dataset(parsed, bbox, state.aoi?.polygons);
    state.dataset = ds;
    state.byFid = new Map(ds.points.map((p) => [p.fid, p]));
    state.loadOpts = opts;
    state.loadedAoi = state.aoi;
    state.dem = null;
    map.getSource('buildings').setData({ type: 'FeatureCollection', features: ds.buildings.map((p) => p.feature) });
    map.getSource('facilities').setData({ type: 'FeatureCollection', features: ds.facilities.map((p) => p.feature) });
    map.getSource('roads').setData({ type: 'FeatureCollection', features: parsed.roads });
    map.getSource('waterways').setData({ type: 'FeatureCollection', features: parsed.waterways });
    const [w, s, e, n] = bbox;
    map.getSource('bbox').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] } });
    clearExposure();
    clearRisk();
    clearSVI();
    clearMH();
    $('run-mh').disabled = false;
    $('run-svi').disabled = false;
    $('wb-fetch').disabled = false;
    $('run').disabled = false;
    $('run-risk').disabled = false;
    applyPopulation();
    updateReportChecklist();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`Loaded ${fmt(ds.buildings.length)} buildings, ${fmt(ds.facilities.length)} facilities, ${fmt(parsed.roads.length)} road and ${fmt(parsed.waterways.length)} waterway lines in ${secs}s.` +
      (opts.buildings === 'light' ? ' Building areas are estimated from bounding boxes.' : ''));
    if (state.last) probe(state.last);
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`Could not load data: ${escapeHtml(err.message)}. The public servers may be busy, so try again shortly or load a smaller area.`, true);
  } finally {
    $('progress').classList.add('hidden');
    updateAoiInfo();
  }
}

$('load').addEventListener('click', loadData);
$('clear-cache').addEventListener('click', async (e) => {
  e.preventDefault();
  await clearCache();
  setStatus('Download cache cleared.');
});

// ---- Population ---------------------------------------------------------------------------

function popParams() {
  return {
    m2PerPerson: Math.max(1, +$('pop-m2').value || DEFAULT_POP.m2PerPerson),
    defaultLevels: Math.max(1, +$('pop-levels').value || 1),
    knownTotal: Math.max(0, +$('pop-known').value || 0),
    unknownResidential: $('pop-unknown').checked,
  };
}

function applyPopulation() {
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

for (const id of ['pop-m2', 'pop-levels', 'pop-known', 'pop-unknown']) $(id).addEventListener('change', applyPopulation);

function renderSummary() {
  const ds = state.dataset;
  const s = ds.summary();
  let html = `
    <div class="kpis">
      <div class="kpi"><b>${fmt(Math.round(s.pop))}</b><span>estimated residents in the area</span></div>
      <div class="kpi"><b>${fmt(s.buildings)}</b><span>buildings · ${fmt(s.facilities)} facilities</span></div>
    </div>`;
  if (ds.popFactor !== 1) html += `<p class="note">Calibrated to your census figure: the raw estimate was multiplied by ${ds.popFactor.toFixed(2)}.</p>`;
  html += '<table class="list"><tr><th>Building class</th><th class="num">Count</th><th class="num">Residents</th></tr>';
  for (const [k, label] of Object.entries(BUILDING_CLASSES)) {
    const c = s.classes[k];
    if (c) html += `<tr><td>${label}</td><td class="num">${fmt(c.count)}</td><td class="num">${fmt(Math.round(c.pop))}</td></tr>`;
  }
  html += `</table><p class="note">Road network ${m(s.len.road)} · waterways ${m(s.len.water)} inside the area.</p>`;
  $('area-summary').innerHTML = html + exportsBlock('population');
}

// ---- Cursor probe -------------------------------------------------------------------------

function probe(lngLat) {
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
  const h = dem.elev(lng, lat) - dem.minAround(n.lonlat[0], n.lonlat[1], 2);
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

// ---- Exposure by distance -----------------------------------------------------------------

for (const [k, s] of Object.entries(SOURCES)) $('source').add(new Option(s.label, k));

const isWaterSource = () => $('source').value.startsWith('water');
function updateElevationOption() {
  $('elev-opts').classList.toggle('hidden', !isWaterSource());
}
$('source').addEventListener('change', updateElevationOption);
updateElevationOption();

async function runExposure() {
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

function clearExposure() {
  state.exposure = null;
  layerCtrl.setAvailable('exposure', false);
  map.getSource('buffer')?.setData(EMPTY);
  map.getSource('exposed')?.setData(EMPTY);
  $('exposure-results').innerHTML = '';
  $('downloads').classList.add('hidden');
}

$('run').addEventListener('click', runExposure);
$('clear').addEventListener('click', clearExposure);

// ---- Flood risk ---------------------------------------------------------------------------

$('scenario-table').tBodies[0].innerHTML = DEFAULT_SCENARIOS.map((s) => `<tr>
  <td><input type="number" class="sc-rp" min="2" max="10000" step="1" value="${s.rp}" aria-label="Return period in years"></td>
  <td><input type="number" class="sc-level" min="0" max="30" step="0.1" value="${s.level}" aria-label="Water level in metres"></td></tr>`).join('');
$('cost-inputs').innerHTML = Object.entries(DEFAULT_COSTS).map(([k, v]) =>
  `<label class="field"><span>${BUILDING_CLASSES[k].split(/[ (]/)[0]}</span><input type="number" id="cost-${k}" min="0" step="10" value="${v}"></label>`).join('');

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
    contentsPct: Math.max(0, +$('contents').value || 0),
    currency: $('currency').value.trim() || 'USD',
  };
}

// Elevation for the loaded area, shared by the flood and multi-hazard steps.
// Padded ~1.5 km so rivers, slopes and avalanche paths just outside are covered.
async function ensureDEM(statusEl) {
  const ds = state.dataset;
  const key = ds.bbox.join(',');
  if (state.dem?.key === key) return state.dem.dem;
  const [w, s, e, n] = ds.bbox;
  const pad = 0.015;
  const dem = await loadDEM([w - pad, s - pad, e + pad, n + pad], {
    onProgress: (done, total) => (statusEl.textContent = `Downloading elevation tiles… ${done}/${total}`),
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

function computeRisk(P = state.risk?.params ?? riskParams()) {
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
  $('risk-status').textContent = `Assessed ${fmt(state.risk.assessed)} buildings and facilities within ${m(P.maxDist)} of ${SOURCES[P.source].label.toLowerCase()} using elevation zoom ${state.dem.dem.z} (${Math.round(performance.now() - t0)} ms).`;
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
}

function clearRisk() {
  state.risk = null;
  layerCtrl.setAvailable('depth', false);
  map.getSource('risk')?.setData(EMPTY);
  $('risk-results').innerHTML = '';
  $('risk-status').textContent = '';
  $('finance').classList.add('hidden');
}

$('run-risk').addEventListener('click', runRisk);

// ---- Risk finance ---------------------------------------------------------------------------

function financeParams() {
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

// ---- Social vulnerability ---------------------------------------------------------------------

$('share-inputs').innerHTML = Object.entries(GROUPS).map(([k, g]) =>
  `<label class="field"><span>${g.label}</span><input type="number" id="share-${k}" min="0" max="100" step="0.1" value="${DEFAULT_SHARES[k]}"></label>`).join('');
$('svi-indicators').innerHTML = Object.entries(SVI_INDICATORS).map(([k, ind]) =>
  `<label><input type="checkbox" class="svi-ind" value="${k}" ${k === 'census' ? 'disabled' : 'checked'}><span>${ind.label}<span class="muted">${ind.note}</span></span></label>`).join('');

const census = { features: [], name: '' };

function shares() {
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

function runSVI() {
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
}

$('svi-mode').addEventListener('change', () => {
  if (!state.sviDone) return;
  classifyAndShowSVI();
  renderSVI();
  if (state.mh) combineMH(false);
});

function renderSVI() {
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

function clearSVI() {
  state.sviDone = null;
  layerCtrl.setAvailable('svi', false);
  map.getSource('svi')?.setData(EMPTY);
  $('svi-results').innerHTML = '';
}

$('run-svi').addEventListener('click', runSVI);

// ---- Multi-hazard risk ------------------------------------------------------------------------

const HZ_SETTINGS = {
  river: () => `100-yr level: ${floodLevel()} m (step 5)`,
  coastal: () => '<label>Sea level + surge <input type="number" id="hz-coast" min="0" max="20" step="0.5" value="2" style="width:60px"> m</label>',
  avalanche: () => '<label>Snow line <input type="number" id="hz-snow" min="0" max="7000" step="100" value="2500" style="width:72px"> m</label>',
  earthquake: () => 'USGS catalogue + building type',
  glof: () => 'Lakes ≤ 30 km upstream',
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

const lakeUploads = [];
$('lake-file').accept = ACCEPT;
$('lake-file').addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files?.length) return;
  try {
    const { features } = await readSpatialFiles(files);
    const lakes = lakesFromFeatures(features);
    if (!lakes.length) throw new Error('no points or polygons found');
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

async function runMH() {
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
      glof: use.has('glof') && have.glof !== lakeUploads.length, // refetch when lakes are uploaded
      coast: use.has('coastal') && !have.coast,
    };
    const { parts, errors } = await loadHazardContext(ds.bbox, { need, extraLakes: lakeUploads, onStatus: (t) => ($('mh-status').textContent = t) });
    Object.assign(ctx, parts);
    for (const k of ['earthquake', 'glof', 'coastal']) {
      const asked = { earthquake: need.quakes, glof: need.glof, coastal: need.coast }[k];
      if (asked) ctx.errors[k] = errors[k];
    }
    if (need.quakes && parts.quakes) have.quakes = true;
    if (need.glof && parts.lakes) have.glof = lakeUploads.length;
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
    };
    const notes = scoreHazards(ds, dem, ctx, P);
    state.mh = { use, notes, weights: mhWeights(use), ctx, settings: P, ms: Math.round(performance.now() - t0), show: 'mhi' };
    combineMH();
    $('mh-status').textContent = `Scored ${fmt(ds.points.length)} buildings and facilities for ${use.size} hazards in ${(state.mh.ms / 1000).toFixed(1)}s (elevation zoom ${dem.z}).`;
  } catch (err) {
    $('mh-status').innerHTML = `<span class="warn">Multi-hazard analysis failed: ${escapeHtml(err.message)}</span>`;
  } finally {
    $('run-mh').disabled = false;
  }
}

// Recombine scores (weights, population or social vulnerability changed) and
// redraw; `show` also switches the map to the multi-hazard layer.
function combineMH(show = true) {
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

function mhValue(p, k = state.mh.show) {
  return k === 'mhi' ? p.mhi : k === 'risk' ? p.risk : p.hz?.[k];
}

// Buildings coloured for one multi-hazard view ('mhi', 'risk' or a hazard key).
function mhFeatures(k = state.mh.show) {
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

function clearMH() {
  state.mh = null;
  layerCtrl.setAvailable('mh', false);
  map.getSource('mh')?.setData(EMPTY);
  $('mh-results').innerHTML = '';
  $('mh-status').textContent = '';
}

$('run-mh').addEventListener('click', runMH);

// ---- Downloads (light: points, 6-decimal coordinates, essential fields) ------------------------

function download(name, text, type) {
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

function pointsGeoJSON(rows) {
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

function csvOf(rows) {
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

// ---- Search, mobile ---------------------------------------------------------------------------

$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-q').value.trim();
  if (!q) return;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`);
    const [hit] = await res.json();
    if (!hit) return setStatus(`No place found for “${escapeHtml(q)}”.`, true);
    const [s, n, w, ea] = hit.boundingbox.map(Number);
    map.fitBounds([[w, s], [ea, n]], { maxZoom: 16, duration: 1200 });
    setStatus(`Moved to ${escapeHtml(hit.display_name)}. Draw an area or zoom in, then load data.`);
  } catch {
    setStatus('Search is unavailable right now.', true);
  }
});

$('panel-toggle').addEventListener('click', () => {
  $('panel').classList.toggle('collapsed');
  setTimeout(() => map.resize(), 50);
});

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
const CREDITS = 'Data © OpenStreetMap contributors (ODbL), AWS Terrain Tiles, USGS, World Bank';

// Map layout settings for a step's map. `view` picks the multi-hazard view.
function mapSpec(step, view) {
  const S = snapshot();
  const [w, s, e, n] = state.dataset.bbox;
  const base = {
    bounds: [[w, s], [e, n]], credits: CREDITS,
    subtitle: `${S.areaLabel} · ${S.areaKm2.toFixed(2)} km² · ${S.dateLabel}`,
    legend: [...(state.loadedAoi ? [{ label: 'Analysed area', color: '#7048e8', kind: 'line' }] : []), ...ORIENT_LEGEND],
  };
  const fmtN = (v) => fmt(Math.round(v));
  if (step === 'population') {
    const sum = state.dataset.summary();
    return { ...base, file: 'map-buildings-facilities', title: 'Buildings and facilities', show: ['facilities'], hide: [...PROBE_LAYERS, ...others(null)],
      legend: [{ label: 'Building', color: '#5c6b7a', kind: 'fill' }, ...base.legend, ...Object.values(FACILITY_GROUPS).map((g) => ({ label: g.label, color: g.color, kind: 'dot' }))], stats: [['estimated residents', fmtN(sum.pop)], ['buildings', fmtN(sum.buildings)], ['facilities', fmtN(sum.facilities)]] };
  }
  if (step === 'exposure') {
    const E = state.exposure;
    return { ...base, file: 'map-exposure', title: `Exposure within ${E.dist} m of ${SOURCES[E.sourceKey].label.toLowerCase()}`,
      show: COLOUR_LAYERS.exposure, hide: [...PROBE_LAYERS, ...NO_FACILITIES, ...others('exposure')],
      legend: [{ label: E.elevation ? `Flood-exposed (≤ ${E.maxHeight} m above water)` : 'Within distance', color: '#e03131', kind: 'fill' },
        ...(E.elevation ? [{ label: 'Steep bank (erosion risk)', color: '#f08c00', kind: 'fill' }] : []),
        { label: 'Exposed facility', color: '#e03131', kind: 'ring' }, { label: `${E.dist} m buffer`, color: '#fcc2c2', kind: 'fill' }, ...base.legend],
      stats: [[`residents ${E.elevation ? 'flood-exposed' : 'within distance'}`, fmtN(E.pop)], ['buildings', fmtN(E.buildings)], ...(E.elevation ? [['residents on steep banks', fmtN(E.bank.pop)]] : [])] };
  }
  if (step === 'flood') {
    const R = state.risk;
    const sc = R.scenarios[state.riskScenario];
    return { ...base, file: `map-flood-depth-${sc.rp}yr`, title: `Flood depth: ${sc.rp}-year flood (${sc.level} m above the channel)`,
      show: COLOUR_LAYERS.depth, hide: [...PROBE_LAYERS, ...NO_FACILITIES, ...others('depth')], legendTitle: 'Flood depth', ramp: DEPTH_CLASSES.map((c) => ({ label: c.label, color: c.color })),
      stats: [['buildings flooded', fmtN(sc.buildings)], ['people affected', fmtN(sc.pop)], [`loss (${R.params.currency})`, compact(sc.loss)], [`average annual loss (${R.params.currency})`, compact(R.aal)]] };
  }
  if (step === 'svi') {
    const sv = sviSummary(state.dataset);
    return { ...base, file: 'map-social-vulnerability', title: 'Social vulnerability of homes',
      show: COLOUR_LAYERS.svi, hide: [...PROBE_LAYERS, ...NO_FACILITIES, ...others('svi')], legendTitle: `Social vulnerability (${state.sviDone.mode})`, ramp: SVI_CLASSES.map((c) => ({ label: c.label, color: c.color })),
      stats: [['residents in high or very high vulnerability homes', fmtN(sv.classes[3].pop + sv.classes[4].pop)], ['homes scored', fmtN(sv.classes.reduce((a, c) => a + c.buildings, 0))]] };
  }
  if (step === 'mh') {
    const k = view ?? state.mh.show;
    const label = k === 'mhi' ? 'Multi-hazard index' : k === 'risk' ? 'Combined risk (hazard × social vulnerability)' : `${HAZARDS[k].label} hazard`;
    const homes = state.dataset.buildings.filter((b) => b.pop > 0 && b.hz);
    const high = homes.filter((b) => (mhValue(b, k) ?? 0) >= HIGH).reduce((a, b) => a + b.pop, 0);
    return { ...base, file: `map-${k === 'mhi' ? 'multi-hazard' : k === 'risk' ? 'combined-risk' : `hazard-${k}`}`, title: label,
      show: COLOUR_LAYERS.mh, hide: [...PROBE_LAYERS, ...NO_FACILITIES, ...others('mh')], data: { mh: mhFeatures(k) }, legendTitle: label, ramp: SCORE_CLASSES.map((c) => ({ label: c.label, color: c.color })),
      stats: [[`residents at score ≥ ${HIGH}`, fmtN(high)], ['residents assessed', fmtN(homes.reduce((a, b) => a + b.pop, 0))]] };
  }
  return null;
}

async function exportMap(step, view, statusEl) {
  const spec = mapSpec(step, view);
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
function exportsBlock(step) {
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

// Everything the export needs, as currently shown in the app.
function snapshot() {
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
    exposure: state.exposure,
    risk: state.risk,
    riskScenario: state.riskScenario ?? 0,
    finance,
    layers: state.risk ? financeLayers(state.risk.curve, finance) : null,
    svi: state.sviDone,
    shares: shares(),
    mh: state.mh,
  };
}

// Which steps have run, each with its own detailed CSV.
function updateReportChecklist() {
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

const stamp = () => new Date().toISOString().slice(0, 10);

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

// ---- Version ----------------------------------------------------------------------------------

for (const a of document.querySelectorAll('.version-link')) {
  a.textContent = `v${VERSION}`;
  a.href = `${REPO}/releases`;
}

// ---- Welcome / how-to dialog ------------------------------------------------------------------

const HELP_KEY = 'openhvra-help-hidden';
function helpHidden() {
  try {
    return localStorage.getItem(HELP_KEY) === '1';
  } catch {
    return false;
  }
}
$('help-btn').addEventListener('click', () => {
  $('help-hide').checked = helpHidden();
  $('help').showModal();
});
$('help-close').addEventListener('click', () => $('help').close());
$('help').addEventListener('close', () => {
  try {
    if ($('help-hide').checked) localStorage.setItem(HELP_KEY, '1');
    else localStorage.removeItem(HELP_KEY);
  } catch {
    /* storage unavailable: the dialog simply shows again next time */
  }
});
// Clicking the dimmed backdrop closes it too.
$('help').addEventListener('click', (e) => {
  if (e.target === $('help')) $('help').close();
});
if (!helpHidden()) $('help').showModal();

// ---- Formatting -------------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function fmt(n) {
  return n.toLocaleString();
}
function compact(v) {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: v >= 1000 ? 1 : 0 }).format(v);
}
function money(v, cur) {
  return `${escapeHtml(cur)} ${compact(v)}`;
}
function pctOf(a, b) {
  return b ? `${((100 * a) / b).toFixed(2)}%` : '0%';
}
function m(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
}
function nearestText(n) {
  return n ? m(n.d) : '> 4 km';
}
function row(label, value) {
  return `<tr><td>${label}</td><td class="num">${value}</td></tr>`;
}
function pretty(t) {
  return String(t).replace(/_/g, ' ');
}
function lineName(l) {
  return l.name ? `${escapeHtml(l.name)} <span class="muted">(${pretty(l.type)})</span>` : pretty(l.type);
}
function groupTable(groups) {
  let h = '<table class="list">';
  for (const [g, def] of Object.entries(FACILITY_GROUPS)) {
    if (groups[g]) h += row(`<span class="dot" style="background:${def.color}"></span>${def.label}`, fmt(groups[g]));
  }
  return h + '</table>';
}
function featureLabel(p) {
  const color = FACILITY_GROUPS[p.group]?.color ?? '#5c6b7a';
  const label = p.name ? `${escapeHtml(p.name)} <span class="muted">· ${escapeHtml(pretty(p.type))}</span>` : escapeHtml(pretty(p.type));
  return `<span class="dot" style="background:${color}"></span><a href="https://www.openstreetmap.org/${p.osm_id}" target="_blank" rel="noopener">${label}</a>`;
}
