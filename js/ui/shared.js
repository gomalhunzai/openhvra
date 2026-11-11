// Shared app state, the $ helper and constants used by several steps.

export const MAX_AREA_KM2 = { light: 60, footprints: 25 };
export const EMPTY = { type: 'FeatureCollection', features: [] };
export const $ = (id) => document.getElementById(id);
// Sequential blue ramp (ordinal steps 250→700) for flood depth classes.
export const DEPTH_CLASSES = [
  { max: 0.5, color: '#86b6ef', label: '< 0.5 m' },
  { max: 1, color: '#5598e7', label: '0.5–1 m' },
  { max: 2, color: '#2a78d6', label: '1–2 m' },
  { max: 3, color: '#1c5cab', label: '2–3 m' },
  { max: Infinity, color: '#0d366b', label: '> 3 m' },
];
export const state = {
  dataset: null,
  completeness: null, // OSM building completeness against GHSL (step 1)
  osmParsed: null, // OSM data as downloaded (step 1)
  addedBuildings: null, // buildings added from Overture to fill gaps (step 1)
  addedFacilities: null, // critical facilities added from Overture places (step 1)
  facilityCheck: null, // OSM critical facilities against Overture places (step 1)
  marks: { lakes: [], glaciers: [], paths: {} }, // user-marked glacial lakes, glaciers and outflow paths
  drawPurpose: null, // set while drawing a GLOF mark instead of an area
  is3d: false, // 3D view (terrain + building extrusions) switched on
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
