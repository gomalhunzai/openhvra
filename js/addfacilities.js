// Fill gaps in OSM critical facilities with places from the Overture Maps
// places theme (from Meta, Microsoft and other sources), read from
// Overture's PMTiles archive.
//
// Only places in the critical facility groups are used, matched to the OSM
// tags the app already uses for those groups (see classifyFacility in osm.js).
// A place is left out as a probable duplicate if an OSM facility of the same
// group, or with the same name, lies within DUP_RADIUS_M.

import { PMTiles } from './pmtiles.js';
import { decodePoints } from './mvt.js';
import { latestRelease, tileRange } from './addbuildings.js';
import { makeProjection, GridIndex } from './spatial.js';

export const OVERTURE_PLACES_CREDIT = 'Overture Maps Foundation, places theme (CDLA Permissive 2.0; records from Foursquare under Apache 2.0)';
// Overture gives no recommended cut-off. An independent check found places
// with confidence ≥ 0.6 were correct 81% of the time (95% at ≥ 0.9).
export const MIN_CONFIDENCE = 0.6;
// Default maximum matching distance of the OSM Conflator tool; studies use 50–1000 m.
export const DUP_RADIUS_M = 100;
const Z = 14;

// Overture basic_category → OpenHVRA facility group.
const G = (group, cats) => cats.split(' ').map((c) => [c, group]);
export const PLACE_GROUPS = Object.fromEntries([
  ...G('health', 'hospital health_care emergency_department emergency_or_urgent_care_facility primary_care_or_general_clinic outpatient_care_facility pediatric_clinic dental_clinic pharmacy_and_drug_store medical_service specialized_health_care specialized_medical_facility surgery diagnostics_imaging_or_lab_service reproductive_perinatal_and_womens_care behavioral_or_mental_health_clinic vision_or_eye_care_clinic physical_medicine_and_rehabilitation senior_living_facility'),
  ...G('education', 'elementary_school middle_school high_school preschool college_university education educational_facility place_of_learning specialty_school library'),
  ...G('emergency', 'fire_station police_station park stadium_arena'),
  ...G('community', 'government_office government_department community_and_government community_center civic_center courthouse embassy place_of_worship christian_place_of_worship muslim_place_of_worship hindu_place_of_worship buddhist_place_of_worship jewish_place_of_worship cultural_center museum historic_site monument castle social_or_community_service'),
  ...G('utilities', 'public_utility water_utility_provider electric_utility_provider public_restroom'),
  ...G('transport', 'airport train_station public_transit_facility_or_service rail_facility_or_service'),
  ...G('hazardous', 'gas_station fueling_station'),
]);

const placesUrl = (release) => `https://tiles.overturemaps.org/${release}/places.pmtiles`;

// Source datasets of a place, e.g. 'meta; Foursquare'.
function datasets(p) {
  try {
    return [...new Set(JSON.parse(p.sources ?? '[]').map((s) => s.dataset).filter(Boolean))].join('; ');
  } catch {
    return '';
  }
}

function primaryName(p) {
  if (p['@name']) return p['@name'];
  try {
    return JSON.parse(p.names ?? '{}').primary ?? '';
  } catch {
    return '';
  }
}

// Usable critical places touching bbox: { release, tiles, bytes, places, skipped }.
export async function fetchPlaces(bbox, { release, signal, onProgress, fetchImpl = fetch } = {}) {
  const rel = release ?? (await latestRelease(fetchImpl, signal));
  const pm = new PMTiles(placesUrl(rel), fetchImpl);
  const { x0, x1, y0, y1 } = tileRange(bbox, Z);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  const byId = new Map();
  const skipped = { lowConfidence: 0, closed: 0 };
  let bytes = 0;
  let done = 0;
  await Promise.all(jobs.map(async ([x, y]) => {
    const t = await pm.getTile(Z, x, y, signal);
    onProgress?.(++done, jobs.length);
    if (!t) return;
    bytes += t.length;
    for (const f of decodePoints(t, 'place', Z, x, y)) {
      const p = f.properties;
      const group = PLACE_GROUPS[p.basic_category];
      if (!group || byId.has(p.id)) continue;
      if (p.operating_status && p.operating_status !== 'open') {
        skipped.closed++;
        continue;
      }
      if (!(p.confidence >= MIN_CONFIDENCE)) {
        skipped.lowConfidence++;
        continue;
      }
      byId.set(p.id, { id: p.id, lonlat: f.points[0], group, category: p.basic_category, name: primaryName(p), confidence: p.confidence, datasets: datasets(p) });
    }
  }));
  return { release: rel, tiles: jobs.length, bytes, places: [...byId.values()], skipped };
}

const norm = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Splits places into new ones and probable duplicates of OSM facilities.
export function removeDuplicatePlaces(places, osmFacilities, contains, center, radius = DUP_RADIUS_M) {
  const proj = makeProjection(...center);
  const index = new GridIndex(radius);
  for (const f of osmFacilities) {
    const [x, y] = proj.toXY(...f.center);
    index.insert({ x, y, group: f.properties.group, name: norm(f.properties.name) }, x, y, x, y);
  }
  const keep = [];
  let duplicates = 0;
  let outside = 0;
  for (const p of places) {
    if (!contains(...p.lonlat)) {
      outside++;
      continue;
    }
    const [x, y] = proj.toXY(...p.lonlat);
    const name = norm(p.name);
    let hit = false;
    index.query(x - radius, y - radius, x + radius, y + radius, (o) => {
      if (hit || Math.hypot(o.x - x, o.y - y) > radius) return;
      // Against OSM: same group or same name. Between Overture places: same name only.
      if (o.overture ? name && o.name === name : o.group === p.group || (name && o.name === name)) hit = true;
    });
    // Two Overture places of the same group and name close together count once.
    if (!hit) index.insert({ x, y, group: p.group, name, overture: true }, x, y, x, y);
    if (hit) duplicates++;
    else keep.push(p);
  }
  return { keep, duplicates, outside };
}

// New places → facility features in the same form as parseOSM's.
export function toFacilityFeatures(keep, firstFid) {
  let fid = firstFid;
  return keep.map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: p.lonlat },
    center: p.lonlat,
    properties: {
      fid: ++fid, osm_id: null, kind: 'facility', group: p.group, type: p.category.replace(/_/g, ' '), name: p.name,
      source: 'Overture places', source_datasets: p.datasets, overture_id: p.id, confidence: Math.round(p.confidence * 100) / 100,
    },
  }));
}
