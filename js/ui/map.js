// The map: basemaps, sources and layers, map controls and layer colours.
// Functions from the step modules are called through `actions`, which those
// modules fill in when they load, so this module never imports them.

import { FACILITY_GROUPS } from '../osm.js';
import { DrawTool } from '../draw.js';
import { DrawControl, LayerControl, ThreeDControl } from '../controls.js';
import { SVI_CLASSES } from '../social.js';
import { SCORE_CLASSES } from '../hazards.js';
import { COMPLETENESS_CLASSES } from '../completeness.js';
import { $, DEPTH_CLASSES, EMPTY, state } from './shared.js';

// Step functions the map controls call; filled in by area.js, glof.js and view3d.js.
export const actions = {};

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
// Elevation for the 3D view: terrain and hillshade read the open Terrarium
// tiles, which are only requested while 3D is switched on.
const DEM = { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: 'Elevation: AWS Terrain Tiles' };
style.sources['dem-terrain'] = DEM;
style.sources['dem-hillshade'] = { ...DEM };
style.layers.push({ id: 'hillshade', type: 'hillshade', source: 'dem-hillshade', layout: { visibility: 'none' }, paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#3d4a57' } });
export const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [20, 15], // global view
  zoom: 1.5,
  hash: true,
  attributionControl: { compact: false },
});
export const draw = new DrawTool(map, {
  onFinish: (shape) => {
    drawCtrl.setActive(null);
    actions.setHint(null);
    const purpose = state.drawPurpose;
    state.drawPurpose = null;
    if (purpose) actions.addMark(purpose, shape);
    else actions.setAoi(shape);
  },
  onHint: (text) => {
    actions.setHint(text);
    if (!text) {
      drawCtrl.setActive(null);
      state.drawPurpose = null;
    }
  },
});
export const drawCtrl = new DrawControl({ onDraw: (...a) => actions.startDraw(...a), onClear: () => actions.setAoi(null), onUpload: () => $('upload-file').click() });
map.addControl(drawCtrl, 'top-left');
map.addControl(new maplibregl.NavigationControl(), 'top-right');
const ramp = (classes) => classes.map((c) => ({ label: c.label, color: c.color }));
export const layerCtrl = new LayerControl({
  onChange: () => actions.refresh3D(),
  basemaps: BASEMAPS,
  basemap: 'osm',
  layers: [
    { key: 'area', label: 'Selected area', ids: ['aoi-fill', 'aoi-line', 'bbox'], symbol: { kind: 'line', color: '#7048e8' } },
    { key: 'completeness', label: 'OSM building completeness (step 1)', ids: ['completeness-fill'], symbol: { kind: 'fill', color: '#6c47c4' }, available: false,
      hint: 'Load data with the completeness check on', ramp: ramp(COMPLETENESS_CLASSES) },
    { key: 'added', label: 'Added from Overture (step 1)', ids: ['added-line', 'added-pt'], symbol: { kind: 'line', color: '#0ca678' }, available: false,
      hint: 'Add missing buildings or facilities in step 1 to show', items: [{ label: 'Building (satellite footprint)', color: '#0ca678' }, { label: 'Facility (ringed)', color: '#0ca678' }] },
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
    { key: 'cryo', label: 'Glaciers, lakes & GLOF paths', ids: ['cryo-glacier-fill', 'cryo-glacier-line', 'cryo-paths-other', 'cryo-paths', 'cryo-lakes', 'cryo-marks-line', 'cryo-marks-pt'], symbol: { kind: 'line', color: '#7048e8' }, available: false,
      hint: 'Run step 7, or mark a glacier or lake, to show',
      items: [{ label: 'Glacier', color: '#a5d8ff' }, { label: 'Glacial lake (dark = drains through your area)', color: '#1971c2' }, { label: 'Outflow path reaching your area', color: '#7048e8' },
        { label: 'Outflow path draining elsewhere', color: '#868e96' }, { label: 'Marked by you', color: '#0c8599' }] },
    { key: 'mh', label: 'Multi-hazard / risk (step 7)', ids: ['mh-fill', 'mh-pt'], symbol: { kind: 'fill', color: '#ad2b2b' }, available: false, exclusive: 'colour',
      hint: 'Run step 7 to show', ramp: ramp(SCORE_CLASSES) },
  ],
});
map.addControl(layerCtrl, 'bottom-left');
const threeD = new ThreeDControl({ onToggle: (on, ex) => actions.set3D(on, ex), onExaggeration: (ex) => state.is3d && map.setTerrain({ source: 'dem-terrain', exaggeration: ex }) });
map.addControl(threeD, 'top-right');
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
export function metresToPixels(metres, lat) {
  const w0 = (metres * 512) / (40075016.686 * Math.cos((lat * Math.PI) / 180));
  return ['interpolate', ['exponential', 2], ['zoom'], 0, w0, 22, w0 * 2 ** 22];
}
map.on('load', () => {
  for (const id of ['completeness', 'added', 'aoi', 'buildings', 'roads', 'waterways', 'facilities', 'buffer', 'exposed', 'svi', 'mh', 'risk', 'cryo-glaciers', 'cryo-lakes', 'cryo-paths', 'cryo-marks', 'b3d', 'bbox', 'probe', 'probe-hits', 'probe-links']) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  const isPoint = ['==', ['geometry-type'], 'Point'];
  const ptRadius = ['interpolate', ['linear'], ['zoom'], 13, 1.5, 16, 3, 18, 5];
  const complColor = ['match', ['get', 'cls']];
  COMPLETENESS_CLASSES.forEach((c, i) => complColor.push(i, c.color));
  complColor.push(COMPLETENESS_CLASSES[0].color);
  map.addLayer({ id: 'completeness-fill', type: 'fill', source: 'completeness', paint: { 'fill-color': complColor, 'fill-opacity': ['match', ['get', 'cls'], 3, 0.12, 0.55], 'fill-outline-color': 'rgba(255,255,255,0.6)' } });
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
  map.addLayer({ id: 'b3d', type: 'fill-extrusion', source: 'b3d', layout: { visibility: 'none' }, paint: {
    'fill-extrusion-color': '#9aa4ae', 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.92,
  } });
  map.addLayer({ id: 'cryo-glacier-fill', type: 'fill', source: 'cryo-glaciers', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#d0ebff', 'fill-opacity': 0.55 } });
  map.addLayer({ id: 'cryo-glacier-line', type: 'line', source: 'cryo-glaciers', paint: { 'line-color': '#74c0fc', 'line-width': 1.2 } });
  map.addLayer({ id: 'cryo-paths-other', type: 'line', source: 'cryo-paths', filter: ['!', ['get', 'reaches']], paint: { 'line-color': '#868e96', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'cryo-paths', type: 'line', source: 'cryo-paths', filter: ['get', 'reaches'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7048e8', 'line-width': 3 } });
  map.addLayer({ id: 'cryo-lakes', type: 'circle', source: 'cryo-lakes', paint: {
    'circle-color': ['case', ['get', 'reaches'], '#1971c2', '#74c0fc'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
    'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'area']], 50, 4, 1000, 12],
  } });
  map.addLayer({ id: 'cryo-marks-line', type: 'line', source: 'cryo-marks', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#0c8599', 'line-width': 2, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'cryo-marks-pt', type: 'circle', source: 'cryo-marks', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#0c8599', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'added-line', type: 'line', source: 'added', filter: ['!', isPoint], paint: { 'line-color': '#0ca678', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 18, 2.5] } });
  map.addLayer({ id: 'facilities', type: 'circle', source: 'facilities', paint: {
    'circle-color': groupColor, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 18, 7],
    'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
  } });
  map.addLayer({ id: 'added-pt', type: 'circle', source: 'added', filter: isPoint, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 6, 18, 11], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#0ca678', 'circle-stroke-width': 2.5 } });
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
  actions.updateAoiInfo();
});
