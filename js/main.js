import { loadOSM, clearCache, FACILITY_GROUPS, CRITICAL_GROUPS, BUILDING_CLASSES } from './osm.js';
import { Dataset, SOURCES, DEFAULT_POP } from './analysis.js';
import { circlePolygon, ringBBox, lonLatArea, bboxAreaKm2 } from './spatial.js';
import { loadDEM, floodRisk, financeLayers, expectedAnnual, DEFAULT_SCENARIOS, DEFAULT_COSTS, DEFAULT_FINANCE } from './risk.js';
import { DrawTool } from './draw.js';
import { DrawControl, BasemapControl } from './controls.js';
import { lossCurve } from './chart.js';
import { readSpatialFiles, toAoiPolygons, polygonFeatures, featureLabel as fileFeatureName, ACCEPT } from './upload.js';
import { SVI_INDICATORS, SVI_CLASSES, GROUPS, DEFAULT_SHARES, sviClass, fetchCountryShares, groupCounts, prepareCensus, computeSVI, classifySVI, sviSummary } from './social.js';

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
map.addControl(new BasemapControl(BASEMAPS, 'osm', (id) => {
  for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty(`base-${k}`, 'visibility', k === id ? 'visible' : 'none');
}), 'top-right');
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

// Width in pixels that makes a line `metres` wide on the ground at this latitude.
function metresToPixels(metres, lat) {
  const w0 = (metres * 512) / (40075016.686 * Math.cos((lat * Math.PI) / 180));
  return ['interpolate', ['exponential', 2], ['zoom'], 0, w0, 22, w0 * 2 ** 22];
}

map.on('load', () => {
  for (const id of ['aoi', 'buildings', 'roads', 'waterways', 'facilities', 'buffer', 'exposed', 'svi', 'risk', 'bbox', 'probe', 'probe-hits', 'probe-links']) {
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
  map.addLayer({ id: 'exposed-fill', type: 'fill', source: 'exposed', filter: ['!', isPoint], paint: { 'fill-color': '#e03131', 'fill-opacity': 0.75 } });
  map.addLayer({ id: 'svi-fill', type: 'fill', source: 'svi', filter: ['!', isPoint], paint: { 'fill-color': sviColor, 'fill-opacity': 0.9 } });
  map.addLayer({ id: 'svi-pt', type: 'circle', source: 'svi', filter: isPoint, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 18, 7], 'circle-color': sviColor } });
  map.addLayer({ id: 'risk-fill', type: 'fill', source: 'risk', filter: ['!', isPoint], paint: { 'fill-color': depthColor, 'fill-opacity': 0.9 } });
  map.addLayer({ id: 'risk-pt', type: 'circle', source: 'risk', filter: isPoint, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 18, 7], 'circle-color': depthColor } });
  map.addLayer({ id: 'facilities', type: 'circle', source: 'facilities', paint: {
    'circle-color': groupColor, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 18, 7],
    'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
  } });
  map.addLayer({ id: 'exposed-pt', type: 'circle', source: 'exposed', filter: isPoint, paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 5, 18, 10], 'circle-color': 'rgba(0,0,0,0)',
    'circle-stroke-color': '#e03131', 'circle-stroke-width': 2.5,
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
    $('run-svi').disabled = false;
    $('wb-fetch').disabled = false;
    $('run').disabled = false;
    $('run-risk').disabled = false;
    applyPopulation();
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
  $('area-summary').innerHTML = html;
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
      ${row('Nearest river or canal', res.nearestRiver ? `${lineName(res.nearestRiver.line)} · ${nearestText(res.nearestRiver)}` : '—')}
    </table>`;
  if (res.facilities.length) {
    html += `<div class="sub">Facilities by type</div>${groupTable(res.groups)}<div class="sub">Closest facilities</div><table class="list">`;
    for (const { p, d } of res.facilities.slice(0, 8)) html += row(featureLabel(p), `${Math.round(d)} m`);
    html += '</table>';
  }
  $('probe-stats').innerHTML = html;
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
const HOVER_LAYERS = ['facilities', 'risk-pt', 'risk-fill', 'svi-pt', 'svi-fill', 'buildings-pt', 'buildings-fill'];

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
  if (state.sviDone && p.svi != null) {
    h += `<br>Social vulnerability: ${p.svi.toFixed(2)} (${SVI_CLASSES[p.sviClass ?? sviClass(p.svi)].label}${state.sviDone.mode === 'relative' ? ' for this area' : ''})`;
  }
  return h;
}

$('map').addEventListener('mouseleave', () => popup.remove());

// ---- Exposure by distance -----------------------------------------------------------------

for (const [k, s] of Object.entries(SOURCES)) $('source').add(new Option(s.label, k));

function runExposure() {
  const ds = state.dataset;
  if (!ds) return;
  const dist = Math.max(1, Math.min(2000, +$('dist').value || 100));
  const res = ds.exposure($('source').value, dist);
  state.exposure = res;

  const lat = (ds.bbox[1] + ds.bbox[3]) / 2;
  map.setPaintProperty('buffer', 'line-width', metresToPixels(dist * 2, lat));
  map.getSource('buffer').setData({ type: 'FeatureCollection', features: res.sourceLines.map((l) => l.feature) });
  map.getSource('exposed').setData({ type: 'FeatureCollection', features: res.hits.map(({ p }) => p.feature) });

  const src = SOURCES[res.sourceKey];
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '0');
  let html;
  if (!res.sourceLines.length) {
    html = `<p class="warn">No ${escapeHtml(src.label.toLowerCase())} are mapped in the loaded area.</p>`;
  } else {
    const fac = Object.values(res.groups).reduce((a, b) => a + b, 0);
    html = `
      <div class="kpis">
        <div class="kpi alert"><b>${fmt(Math.round(res.pop))}</b><span>est. residents (${pct(res.pop, res.totals.pop)}%) within ${dist} m of ${escapeHtml(src.short)}</span></div>
        <div class="kpi alert"><b>${fmt(res.buildings)}</b><span>of ${fmt(res.totals.buildings)} buildings (${pct(res.buildings, res.totals.buildings)}%)</span></div>
        <div class="kpi alert"><b>${fmt(fac)}</b><span>of ${fmt(res.totals.facilities)} facilities</span></div>
        <div class="kpi"><b>${m(res.sourceLength)}</b><span>of ${escapeHtml(src.label.toLowerCase())} in the area</span></div>
      </div>
      <p class="note">Distances are measured from each feature's centre.</p>`;
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
  $('exposure-results').innerHTML = html;
  $('downloads').classList.toggle('hidden', !res.hits.length);
}

function clearExposure() {
  state.exposure = null;
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
    const key = ds.bbox.join(',');
    if (state.dem?.key !== key) {
      // Pad the box so the river next to the area's edge is covered too.
      const [w, s, e, n] = ds.bbox;
      const pad = 0.01;
      const dem = await loadDEM([w - pad, s - pad, e + pad, n + pad], {
        onProgress: (done, total) => ($('risk-status').textContent = `Downloading elevation tiles… ${done}/${total}`),
      });
      state.dem = { key, dem };
    }
    state.riskScenario = null;
    computeRisk(P);
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
  $('risk-results').innerHTML = html;
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
  $('svi-toggle').checked = true;
  for (const id of ['svi-fill', 'svi-pt']) map.setLayoutProperty(id, 'visibility', 'visible');
  renderSVI();
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
  html += `<p class="note">Computed for ${fmt(ds.buildings.filter((b) => b.pop > 0).length)} homes in ${state.sviDone.ms} ms. The index reflects mapped OSM facilities; missing clinics or shelters in OSM make an area look more vulnerable than it is.</p>`;
  $('svi-results').innerHTML = html;
}

function clearSVI() {
  state.sviDone = null;
  map.getSource('svi')?.setData(EMPTY);
  $('svi-results').innerHTML = '';
}

$('run-svi').addEventListener('click', runSVI);

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
  return state.exposure.hits.map(({ p, d }) => ({ p, props: { distance_m: Math.round(d) } }));
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

// ---- Search, layers, legend, mobile ----------------------------------------------------------

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

document.querySelectorAll('[data-layers]').forEach((cb) => {
  cb.addEventListener('change', () => {
    for (const id of cb.dataset.layers.split(',')) map.setLayoutProperty(id, 'visibility', cb.checked ? 'visible' : 'none');
  });
});

$('legend').innerHTML =
  Object.values(FACILITY_GROUPS).map((d) => `<li><span class="dot" style="background:${d.color}"></span>${d.label}</li>`).join('') +
  '<li><span class="dot" style="background:#1c7ed6"></span>Waterway</li>' +
  '<li><span class="dot" style="background:#f59f00"></span>Major road</li>' +
  '<li><span class="dot" style="background:#e03131"></span>Exposed feature</li>' +
  '<li><span class="dot" style="background:#ffd43b;outline:1px solid #1d2329"></span>Inside probe</li>' +
  '<li><span class="dot" style="background:#2a78d6"></span>Flooded building (darker = deeper)</li>' +
  '<li><span class="dot" style="background:#b8481b"></span>Social vulnerability (darker = higher)</li>';

$('panel-toggle').addEventListener('click', () => {
  $('panel').classList.toggle('collapsed');
  setTimeout(() => map.resize(), 50);
});

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
