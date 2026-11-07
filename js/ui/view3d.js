// 3D view: terrain, hillshade and extruded buildings.

import { makeProjection } from '../spatial.js';
import { SVI_CLASSES } from '../social.js';
import { SCORE_CLASSES } from '../hazards.js';
import { DEPTH_CLASSES, state } from './shared.js';
import { actions, layerCtrl, map } from './map.js';
import { mhValue } from './multihazard.js';

// ---- 3D view ------------------------------------------------------------------------------------

// Flat building fills fade out in 3D (the extrusions replace them); their
// opacities are restored when 3D is switched off.
const FLAT_BUILDING_PAINT = {
  'buildings-fill': 'fill-opacity', 'buildings-line': 'line-opacity', 'buildings-pt': 'circle-opacity', 'exposed-fill': 'fill-opacity',
  'risk-fill': 'fill-opacity', 'risk-pt': 'circle-opacity', 'svi-fill': 'fill-opacity', 'svi-pt': 'circle-opacity', 'mh-fill': 'fill-opacity', 'mh-pt': 'circle-opacity',
};
export const saved2D = {};
const GREY_3D = '#c4c9cf';
function set3D(on, exaggeration) {
  state.is3d = on;
  if (on) {
    map.setTerrain({ source: 'dem-terrain', exaggeration });
    map.setLayoutProperty('hillshade', 'visibility', 'visible');
    // A light sky and horizon haze instead of the empty page behind a tilted map.
    if (typeof map.setSky === 'function') {
      map.setSky({ 'sky-color': '#a9cbee', 'horizon-color': '#e6eef7', 'fog-color': '#e6eef7', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 });
    }
    for (const [id, prop] of Object.entries(FLAT_BUILDING_PAINT)) {
      saved2D[id] = { [prop]: map.getPaintProperty(id, prop) ?? 1 };
      map.setPaintProperty(id, prop, 0);
    }
    refresh3D();
    // Tilt only once the elevation under the view has loaded, restoring the
    // view from before 3D: when terrain arrives MapLibre 4 keeps the camera
    // altitude and changes the zoom, and tilting before that in high mountains
    // leaves the camera inside the terrain (a blank or broken view).
    const center = map.getCenter();
    const zoom = map.getZoom();
    const tilt = () => {
      if (!state.is3d) return;
      map.jumpTo({ center, zoom });
      map.easeTo({ pitch: 55, duration: 900 });
    };
    let done = false;
    const once = () => {
      if (!done) {
        done = true;
        tilt();
      }
    };
    map.once('idle', once);
    setTimeout(once, 20000);
  } else {
    map.setTerrain(null);
    map.setLayoutProperty('hillshade', 'visibility', 'none');
    map.setLayoutProperty('b3d', 'visibility', 'none');
    for (const [id, props] of Object.entries(saved2D)) for (const [prop, v] of Object.entries(props)) map.setPaintProperty(id, prop, v);
    map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
  }
}
// Square block for buildings mapped as points (Light mode), sized from the footprint estimate.
function blockAround(b) {
  const half = Math.min(30, Math.max(2, Math.sqrt(b.footprint || 60) / 2));
  const [lon, lat] = b.feature.center;
  const p = makeProjection(lon, lat);
  const ring = [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]].map(([x, y]) => p.toLonLat(x, y));
  return { type: 'Polygon', coordinates: [ring] };
}
// Colour of the extrusions: the thematic layer that is switched on.
function colour3D(mode) {
  if (mode === 'none') return '#9aa4ae';
  if (mode === 'exposure') return ['match', ['coalesce', ['get', 'v'], ''], 'flood', '#e03131', 'bank', '#f08c00', GREY_3D];
  if (mode === 'svi') {
    const e = ['match', ['coalesce', ['get', 'v'], -1]];
    SVI_CLASSES.forEach((c, i) => e.push(i, c.color));
    return [...e, GREY_3D];
  }
  const classes = mode === 'depth' ? DEPTH_CLASSES : SCORE_CLASSES;
  const step = ['step', ['get', 'v'], classes[0].color];
  classes.slice(0, -1).forEach((c, i) => step.push(c.max, classes[i + 1].color));
  return ['case', ['==', ['get', 'v'], null], GREY_3D, step];
}
// Rebuild the extruded buildings: real height (storeys × 3 m), coloured by the active layer.
export function refresh3D() {
  if (!state.is3d || !map.getSource('b3d')) return;
  const ds = state.dataset;
  const show = !!ds && layerCtrl.isOn('buildings');
  map.setLayoutProperty('b3d', 'visibility', show ? 'visible' : 'none');
  if (!show) return;
  const mode = layerCtrl.isOn('mh') ? 'mh' : layerCtrl.isOn('svi') ? 'svi' : layerCtrl.isOn('depth') ? 'depth' : layerCtrl.isOn('exposure') ? 'exposure' : 'none';
  const exp = mode === 'exposure' ? new Map(state.exposure.all.map((h) => [h.p, h.ex])) : null;
  const features = ds.buildings.map((b) => {
    let v = null;
    if (mode === 'mh') v = mhValue(b) ?? null;
    else if (mode === 'svi') v = b.sviClass ?? null;
    else if (mode === 'depth') v = b.depths?.[state.riskScenario] > 0 ? b.depths[state.riskScenario] : null;
    else if (mode === 'exposure') v = exp.get(b) ?? null;
    if (mode === 'mh' && state.mh.show === 'risk' && b.pop <= 0) v = null;
    const geometry = b.feature.geometry.type === 'Polygon' ? b.feature.geometry : blockAround(b);
    return { type: 'Feature', geometry, properties: { h: Math.max(3, (b.floors ?? 1) * 3), v } };
  });
  map.getSource('b3d').setData({ type: 'FeatureCollection', features });
  map.setPaintProperty('b3d', 'fill-extrusion-color', colour3D(mode));
}

Object.assign(actions, { refresh3D, set3D });
