// Step 1: how complete the OSM buildings and critical facilities are, and
// filling the gaps from Overture Maps when they are not.
//
// Everything comes from OSM. Only when OSM looks incomplete are other sources
// used, for buildings and facilities only:
//   OSM share under 10%  → added automatically, with a caution;
//   10–80%               → offered with a button;
//   80% or more          → nothing added.
// Buildings are compared with the GHSL built-up surface; facilities with the
// critical places Overture lists that are not already in OSM.

import { loadBuiltUp, GHSL_LABEL } from '../ghsl.js';
import { computeCompleteness, completenessGeoJSON, COMPLETENESS_CLASSES, MIN_REF_M2 } from '../completeness.js';
import { fetchCandidates, removeOverlaps, toBuildingFeatures, sourceCounts } from '../addbuildings.js';
import { fetchPlaces, removeDuplicatePlaces, toFacilityFeatures, MIN_CONFIDENCE, DUP_RADIUS_M } from '../addfacilities.js';
import { DEFAULT_POP } from '../analysis.js';
import { CRITICAL_GROUPS, FACILITY_GROUPS } from '../osm.js';
import { $, EMPTY, state } from './shared.js';
import { escapeHtml, fmt } from './format.js';
import { actions, layerCtrl, map } from './map.js';

export const AUTO_BELOW = 0.1;
export const OFFER_BELOW = 0.8;

let grid = null; // GHSL cells for the loaded area, kept to recheck after adding buildings
let places = null; // { release, tiles, bytes, keep, duplicates, skipped, osm } for the loaded area

export function clearCompleteness() {
  state.completeness = null;
  state.addedBuildings = null;
  state.addedFacilities = null;
  state.facilityCheck = null;
  state.addError = null;
  grid = null;
  places = null;
  $('completeness').innerHTML = '';
  map.getSource('completeness')?.setData(EMPTY);
  map.getSource('added')?.setData(EMPTY);
  layerCtrl.setAvailable('completeness', false);
  layerCtrl.setAvailable('added', false);
}

const pct = (v) => `${Math.round(100 * v)}%`;
const ha = (m2) => `${fmt(Math.round(m2 / 1e4 * 10) / 10)} ha`;
const center = ([w, s, e, n]) => [(w + e) / 2, (s + n) / 2];

function check(ds) {
  const buildings = ds.buildings.map((b) => {
    const [lon, lat] = b.feature.center;
    return { lon, lat, area: b.area ?? DEFAULT_POP.pointArea };
  });
  return computeCompleteness(grid, buildings, (lon, lat) => ds.contains(lon, lat));
}

// After loading: both checks, then automatic additions where OSM has under 10%.
// When reopening a project, `restore` ({ buildings?, facilities? }, as saved)
// replaces the automatic rule: exactly what was added before is added again,
// from the saved features if the project has them, otherwise downloaded anew.
export async function runCompleteness(ds, signal, { restore = null } = {}) {
  const el = $('completeness');
  el.innerHTML = '<p class="muted small">Checking how complete the buildings and facilities are…</p>';
  const jobs = [];
  if (state.loadOpts?.buildings !== 'none') jobs.push(checkBuildings(ds, signal));
  if (state.loadOpts?.facilities) jobs.push(checkFacilities(ds, signal));
  await Promise.all(jobs);
  if (state.dataset !== ds) return;
  if (restore) {
    await restoreAdded(restore);
  } else {
    const autoB = state.completeness?.ratio != null && state.completeness.ratio < AUTO_BELOW;
    const autoF = state.facilityCheck?.share != null && state.facilityCheck.share < AUTO_BELOW;
    if (autoB) await addBuildings(true);
    if (autoF && state.dataset) addFacilities(true);
  }
  render();
}

async function restoreAdded({ buildings: B, facilities: F }) {
  if (B?.features) {
    const m = B.meta ?? {};
    state.addedBuildings = {
      features: B.features, auto: B.auto, duplicates: +m.duplicates || 0, release: String(m.release ?? ''), tiles: +m.tiles || 0, MB: +m.MB || 0,
      counts: sourceCounts(B.features),
    };
    const ds = rebuild();
    state.addedBuildings.after = grid ? check(ds) : null;
  } else if (B) {
    await addBuildings(B.auto);
  }
  if (!state.dataset) return;
  if (F?.features) {
    const groups = {};
    for (const f of F.features) groups[f.properties.group] = (groups[f.properties.group] ?? 0) + 1;
    const m = F.meta ?? {};
    state.addedFacilities = { features: F.features, auto: F.auto, groups, duplicates: +m.duplicates || 0, release: String(m.release ?? '') };
    rebuild();
  } else if (F) {
    addFacilities(F.auto);
  }
}

// What was added, for saving in a project (features only when `withData`).
export function addedForProject(withData) {
  const out = {};
  const A = state.addedBuildings;
  if (A) {
    out.buildings = { auto: A.auto, meta: { duplicates: A.duplicates, release: A.release, tiles: A.tiles, MB: A.MB } };
    if (withData) out.buildings.features = A.features;
  }
  const F = state.addedFacilities;
  if (F) {
    out.facilities = { auto: F.auto, meta: { duplicates: F.duplicates, release: F.release } };
    if (withData) out.facilities.features = F.features;
  }
  return out;
}

async function checkBuildings(ds, signal) {
  try {
    const g = await loadBuiltUp(ds.bbox, { signal });
    if (state.dataset !== ds) return;
    grid = g;
    const res = check(ds);
    state.completeness = { ...res, source: GHSL_LABEL, kB: Math.round(g.bytes / 1e3), light: state.loadOpts?.buildings === 'light' };
    map.getSource('completeness')?.setData(completenessGeoJSON(res));
    const show = res.rating?.key !== 'good'; // shown straight away only when incomplete
    layerCtrl.setAvailable('completeness', res.blocks.length > 0, show);
    if (!show) layerCtrl.setVisible('completeness', false);
  } catch (err) {
    if (err.name !== 'AbortError') state.completeness = { error: err.message };
  }
}

async function checkFacilities(ds, signal) {
  try {
    const res = await fetchPlaces(ds.bbox, { signal });
    if (state.dataset !== ds) return;
    const osm = state.osmParsed.facilities.filter((f) => CRITICAL_GROUPS.has(f.properties.group) && ds.contains(...f.center));
    const { keep, duplicates } = removeDuplicatePlaces(res.places, osm, (lon, lat) => ds.contains(lon, lat), center(ds.bbox));
    places = { ...res, keep, duplicates, osm: osm.length };
    const known = osm.length + keep.length;
    state.facilityCheck = { osm: osm.length, missing: keep.length, duplicates, share: known ? osm.length / known : null, release: res.release };
  } catch (err) {
    if (err.name !== 'AbortError') state.facilityCheck = { error: err.message };
  }
}

// Rebuilds every step's data from OSM plus whatever has been added.
function rebuild() {
  const P = state.osmParsed;
  const B = state.addedBuildings?.features ?? [];
  const F = state.addedFacilities?.features ?? [];
  const ds = actions.useDataset({ ...P, buildings: [...P.buildings, ...B], facilities: [...P.facilities, ...F] }, state.dataset.bbox, { keepChecks: true });
  map.getSource('added')?.setData({ type: 'FeatureCollection', features: [...B, ...F] });
  layerCtrl.setAvailable('added', B.length + F.length > 0, B.length + F.length > 0);
  return ds;
}

const nextFid = () => Math.max(0, ...state.dataset.points.map((p) => p.fid));

async function addBuildings(auto = false) {
  const ds = state.dataset;
  const status = $('add-b-status');
  if (status) status.textContent = 'Downloading Overture building tiles…';
  try {
    const cand = await fetchCandidates(ds.bbox, {
      signal: state.abort?.signal,
      onProgress: (done, total) => status && (status.textContent = `Downloading Overture building tiles: ${done} of ${total}…`),
    });
    if (state.dataset !== ds) return;
    const { keep, duplicates } = removeOverlaps(cand.candidates, state.osmParsed.buildings, (lon, lat) => ds.contains(lon, lat), center(ds.bbox));
    const features = toBuildingFeatures(keep, nextFid());
    state.addedBuildings = { features, duplicates, auto, release: cand.release, tiles: cand.tiles, MB: cand.bytes / 1e6, counts: sourceCounts(features) };
    state.addedBuildings.after = check(rebuild());
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.addedBuildings = null;
    if (status) status.innerHTML = `<span class="warn">Could not add buildings: ${escapeHtml(err.message)}.</span>`;
    else state.addError = `Could not add buildings: ${err.message}`;
    return;
  }
  if (!auto) render();
}

function addFacilities(auto = false) {
  if (!places) return;
  const features = toFacilityFeatures(places.keep, nextFid() + (state.addedBuildings?.features.length ?? 0));
  const groups = {};
  for (const f of features) groups[f.properties.group] = (groups[f.properties.group] ?? 0) + 1;
  state.addedFacilities = { features, auto, groups, duplicates: places.duplicates, release: places.release };
  rebuild();
  if (!auto) render();
}

function removeAdded(kind) {
  if (kind === 'b') state.addedBuildings = null;
  else state.addedFacilities = null;
  rebuild();
  render();
}

// ---- Panel ------------------------------------------------------------------------------------

const CAUTION = '<b>Caution:</b> these are not checked on the ground. Check them on the satellite basemap, and treat results as indicative.';

function buildingPart() {
  const C = state.completeness;
  if (!C) return '';
  if (C.error) return `<p class="warn small">Could not check building completeness: ${escapeHtml(C.error)}.</p>`;
  if (C.ratio == null) return '<p class="muted small">Building completeness: GHSL shows no built-up area here, so there is nothing to compare with.</p>';
  const cls = C.rating.key === 'good' ? 'note' : 'warn small';
  let html = `<p class="${cls}"><b>OSM buildings look ${C.rating.label}:</b> they cover about <b>${pct(C.ratio)}</b> of the built-up area that satellite data (GHSL 2020) shows in this area.`;
  if (C.rating.key !== 'good') {
    html += ' Counts of residents, buildings and losses in every step will be <b>too low</b> where buildings are missing.';
    if (C.lowShare > 0.05) html += ` ${pct(C.lowShare)} of the built-up area is in blocks where OSM has less than half of it (dark purple on the map).`;
    html += ` Enter a known population in step 2${state.addedBuildings ? '' : ', add the missing buildings below'}, or help map the gaps in OSM.`;
  }
  html += '</p>';
  if (C.light) {
    html += '<p class="warn small"><b>Light mode overstates this share.</b> Building areas here are estimated from bounding boxes, which are larger than the real footprints of buildings that are not aligned north–south: in a test town the share was about 1.5 times the one from real footprints. Treat it as an upper bound, and load with <b>Footprints</b> for a reliable check.</p>';
  }
  html += `<details class="hint"><summary>How this is checked</summary>
    <p>The footprint area of the OSM buildings (${ha(C.osmTotal)}${C.light ? ', estimated from bounding boxes in Light mode' : ''}) is compared with the <b>${escapeHtml(C.source)}</b>, a satellite-derived estimate of roofed area (${ha(C.refTotal)}), in blocks of about 270 m. Blocks with under ${MIN_REF_M2} m² of built-up area are not classed.</p>
    <p>GHSL is itself a satellite estimate and its accuracy varies by place: it can miss small, closely packed buildings such as those in camps. It shows 2020 (modelled from Sentinel-2 imagery of 2018 and the Landsat archive), so buildings built since then can push the share above 100%. Use it to find gaps, then check them on the satellite basemap.</p>
    <p class="muted">Downloaded ${fmt(C.kB)} kB. Block counts: ${COMPLETENESS_CLASSES.map((c, i) => `${c.label} ${fmt(C.classCounts[i])}`).join(' · ')}.</p>
  </details>`;

  const A = state.addedBuildings;
  if (A) {
    const src = Object.entries(A.counts).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
    const after = A.after?.ratio != null ? ` OSM and the added buildings now cover about <b>${pct(A.after.ratio)}</b> of the GHSL built-up area.` : '';
    html += `<p class="${A.auto ? 'warn small' : 'note'}"><b>${fmt(A.features.length)} buildings added${A.auto ? ' automatically, because OSM has under 10% of the built-up area' : ''}</b> (${escapeHtml(src || 'none')}), from satellite imagery via Overture Maps (release ${escapeHtml(A.release)}); ${fmt(A.duplicates)} more ${A.duplicates === 1 ? 'was left out because it overlaps' : 'were left out because they overlap'} or touch${A.duplicates === 1 ? 'es' : ''} an OSM building.${after} They are outlined in green and included in every step. ${CAUTION}</p>
      <p class="muted small">They have no use, material or storey tags unless Overture has them, so they count as untagged buildings. Downloaded ${A.MB.toFixed(1)} MB (${A.tiles} tiles). Better still, map them in OSM so everyone benefits.</p>
      <button id="remove-b" class="btn block">Remove added buildings</button>`;
  } else if (C.ratio < OFFER_BELOW) {
    html += `<p class="small">Add building footprints missing from OSM, detected from satellite imagery by Microsoft and Google (and Esri where available), from the <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps</a> buildings data. Any that overlap or touch an OSM building are left out, so nothing is counted twice.${C.light ? ' <b>Use Footprints mode for this:</b> in Light mode only the OSM bounding boxes are known, so more real buildings next to OSM ones are left out.' : ''}</p>
      <button id="add-b" class="btn block">Add missing buildings</button>
      <p id="add-b-status" class="muted small">${state.addError ? `<span class="warn">${escapeHtml(state.addError)}</span>` : ''}</p>`;
  }
  return html;
}

function facilityPart() {
  const F = state.facilityCheck;
  if (!F) return '';
  if (F.error) return `<p class="warn small">Could not check facility completeness: ${escapeHtml(F.error)}.</p>`;
  if (F.share == null) return '<p class="muted small">Critical facilities: neither OSM nor Overture lists any in this area.</p>';
  const good = F.share >= OFFER_BELOW;
  let html = `<p class="${good ? 'note' : 'warn small'}"><b>Critical facilities:</b> OSM has ${fmt(F.osm)}; Overture Maps lists ${fmt(F.missing)} more that are not in OSM, so OSM has about <b>${pct(F.share)}</b> of those known.`;
  if (!good) html += ' Facilities at risk will be undercounted where they are missing.';
  html += '</p>';
  const A = state.addedFacilities;
  if (A) {
    const g = Object.entries(A.groups).map(([k, v]) => `${FACILITY_GROUPS[k].label.toLowerCase()} ${fmt(v)}`).join(', ');
    html += `<p class="${A.auto ? 'warn small' : 'note'}"><b>${fmt(A.features.length)} facilities added${A.auto ? ' automatically, because OSM has under 10% of those known' : ''}</b> from Overture Maps places (${escapeHtml(g || 'none')}). ${CAUTION} Overture's places come mostly from business listings, so they are thin in rural areas.</p>
      <button id="remove-f" class="btn block">Remove added facilities</button>`;
  } else if (!good && F.missing > 0) {
    html += `<p class="small">Add the ${fmt(F.missing)} critical facilities that Overture Maps lists and OSM lacks (health, education, emergency, community, utilities, transport, fuel). Only places with a confidence of at least ${MIN_CONFIDENCE} and not marked closed are used, and any within ${DUP_RADIUS_M} m of an OSM facility of the same type or name is left out.</p>
      <button id="add-f" class="btn block">Add missing facilities</button>`;
  }
  return html;
}

function render() {
  const el = $('completeness');
  el.innerHTML = buildingPart() + facilityPart();
  $('add-b')?.addEventListener('click', (e) => {
    e.target.disabled = true;
    state.addError = null;
    addBuildings(false);
  });
  $('add-f')?.addEventListener('click', () => addFacilities(false));
  $('remove-b')?.addEventListener('click', () => removeAdded('b'));
  $('remove-f')?.addEventListener('click', () => removeAdded('f'));
}
