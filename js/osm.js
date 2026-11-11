// Fetching, caching and parsing OpenStreetMap data from the public Overpass API.

import { lonLatArea } from './spatial.js';

// Public Overpass servers, in the default order to try (see rankEndpoints).
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Street furniture that would only add noise to a disaster-risk view.
const AMENITY_NOISE =
  'bench|waste_basket|bicycle_parking|parking_space|parking_entrance|vending_machine|waste_disposal|clock|' +
  'hunting_stand|post_box|telephone|motorcycle_parking|grit_bin|lounger|smoking_area|recycling|letter_box|' +
  'parcel_locker|photo_booth|feeding_place|bicycle_repair_station|dog_toilet|give_box';

const ROADS =
  'motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|' +
  'tertiary_link|unclassified|residential|living_street|service|track|road';
const PATHS = 'footway|path|pedestrian|cycleway|steps|bridleway';
const WATERWAYS = 'river|canal|tidal_channel|stream|brook|drain|ditch';

// ---- Queries ----------------------------------------------------------------
// Two requests run in parallel: buildings (the bulk of the data) and
// everything else. Facilities only need a centre point, so they use the much
// lighter `out center`; "light" buildings use bounding boxes instead of full
// footprints (about 3x smaller downloads).

function bboxStr([w, s, e, n]) {
  return `${s},${w},${n},${e}`;
}

export function buildingsQuery(bbox, light) {
  const b = bboxStr(bbox);
  return `[out:json][timeout:180];
way["building"](${b});
out tags ${light ? 'bb' : 'geom'} qt;
relation["building"](${b});
out tags center qt;`;
}

export function networkQuery(bbox, { roads = true, paths = false, waterways = true, facilities = true } = {}) {
  const b = bboxStr(bbox);
  const hw = [roads && ROADS, paths && PATHS].filter(Boolean).join('|');
  const lines = [
    waterways && `way["waterway"~"^(${WATERWAYS})$"](${b});`,
    hw && `way["highway"~"^(${hw})$"](${b});`,
  ].filter(Boolean);
  const fac = facilities
    ? [
        `nw["amenity"]["amenity"!~"^(${AMENITY_NOISE})$"](${b});`,
        `nw["healthcare"](${b});`,
        `nw["emergency"~"^(assembly_point|ambulance_station|disaster_response|lifeguard_base)$"](${b});`,
        `nw["office"~"^(government|ngo|diplomatic|association)$"](${b});`,
        `nw["shop"](${b});`,
        `nw["tourism"~"^(hotel|hostel|guest_house|motel|museum)$"](${b});`,
        `nw["historic"~"^(monument|castle|archaeological_site|building|palace|monastery|fort|city_gate|temple|church|ruins|heritage)$"](${b});`,
        `nw["heritage"](${b});`,
        `nw["power"~"^(plant|substation)$"](${b});`,
        `nw["man_made"~"^(water_tower|water_works|wastewater_plant|water_well|reservoir_covered|pumping_station|mast|communications_tower|storage_tank|works|petroleum_well|gasometer|silo|dyke|embankment)$"](${b});`,
        `nw["telecom"~"^(exchange|data_center)$"](${b});`,
        `nw["railway"~"^(station|halt)$"](${b});`,
        `nw["aeroway"~"^(aerodrome|helipad|heliport)$"](${b});`,
        `nw["leisure"~"^(park|stadium)$"](${b});`,
      ]
    : [];
  return `[out:json][timeout:180];
${lines.length ? `(${lines.join('')});\nout tags geom qt;` : ''}
${fac.length ? `(${fac.join('')});\nout tags center qt;` : ''}`;
}

// ---- Cache (IndexedDB) --------------------------------------------------------

const CACHE_DB = 'osm-proximity-cache';
const CACHE_TTL = 3 * 24 * 3600 * 1000;

function openCache() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('q');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key) {
  try {
    const db = await openCache();
    return await new Promise((resolve) => {
      const r = db.transaction('q').objectStore('q').get(key);
      r.onsuccess = () => resolve(r.result && Date.now() - r.result.t < CACHE_TTL ? r.result.data : null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function cachePut(key, data) {
  try {
    const db = await openCache();
    db.transaction('q', 'readwrite').objectStore('q').put({ t: Date.now(), data }, key);
  } catch {
    /* caching is best-effort */
  }
}

export async function clearCache() {
  try {
    const db = await openCache();
    db.transaction('q', 'readwrite').objectStore('q').clear();
  } catch {
    /* nothing to clear */
  }
}

// ---- Fetching -----------------------------------------------------------------

async function readJSON(res, onBytes) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    text += decoder.decode(value, { stream: true });
    onBytes?.(bytes);
  }
  return JSON.parse(text + decoder.decode());
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

// ---- Choosing a server ----------------------------------------------------------------
// The public Overpass servers are free and shared, and their speed changes from
// hour to hour. Each query starts on the server that has worked best recently;
// if it hasn't answered after HEDGE_MS, the next server is asked as well, and
// the first complete answer wins (the others are cancelled). A server that
// fails moves to the back of the list for a while.

export const HEDGE_MS = 30000; // ask the next server if no answer after this long
const ATTEMPT_MS = 180000; // give up on one server after this long (matches [timeout:180])
const STATS_KEY = 'openhvra-overpass-stats';
const PENALTY_MS = 10 * 60 * 1000; // how long a failure counts against a server

function loadStats() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STATS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveStats(stats) {
  try {
    globalThis.localStorage?.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    /* best-effort */
  }
}

// Record how a server did: success time (smoothed) or the time of a failure.
export function recordResult(stats, host, ok, ms, now = Date.now()) {
  const s = (stats[host] ??= {});
  if (ok) {
    s.ms = s.ms ? Math.round(0.6 * s.ms + 0.4 * ms) : Math.round(ms);
    s.failedAt = 0;
  } else s.failedAt = now;
  return stats;
}

// Servers in the order to try: recently failed ones last, then fastest first;
// unknown servers keep the list order.
export function rankEndpoints(endpoints, stats, now = Date.now()) {
  const score = (url, i) => {
    const s = stats[new URL(url).host];
    const failed = s?.failedAt && now - s.failedAt < PENALTY_MS ? 1 : 0;
    return [failed, s?.ms ?? 1e9, i];
  };
  return endpoints
    .map((url, i) => ({ url, k: score(url, i) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2])
    .map((x) => x.url);
}

// When a server refuses with "too many requests", its status page says when
// this connection's next slot is free (Overpass software only).
async function slotWait(url, fetchImpl) {
  try {
    const res = await fetchImpl(url.replace(/interpreter$/, 'status'), { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    if (/\d+ slots? available now/.test(text)) return 0;
    const m = [...text.matchAll(/in (-?\d+) seconds/g)].map((x) => +x[1]);
    return m.length ? Math.max(0, Math.min(...m)) : null;
  } catch {
    return null;
  }
}

// Run one query against several servers, starting the next one after
// `hedgeMs` without an answer or as soon as one fails. Resolves with the
// first complete answer and cancels the rest.
export function raceServers(query, endpoints, { signal, onStatus, fetchImpl = fetch, hedgeMs = HEDGE_MS, attemptMs = ATTEMPT_MS, stats = {} } = {}) {
  return new Promise((resolve, reject) => {
    const queue = [...endpoints];
    const running = new Map(); // host → AbortController
    const errors = [];
    let waitSecs = null;
    let done = false;
    let hedgeTimer = null;
    const hosts = () => [...running.keys()].join(' and ');
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(hedgeTimer);
      for (const c of running.values()) c.abort();
      fn(value);
    };
    const armHedge = () => {
      clearTimeout(hedgeTimer);
      if (queue.length) hedgeTimer = setTimeout(launch, hedgeMs);
    };
    signal?.addEventListener('abort', () => finish(reject, signal.reason), { once: true });

    function launch() {
      if (done) return;
      const url = queue.shift();
      if (!url) {
        if (!running.size) finish(reject, Object.assign(new Error(errors.join('; ') || 'no servers'), { waitSecs }));
        return;
      }
      const host = new URL(url).host;
      const ctrl = new AbortController();
      running.set(host, ctrl);
      onStatus?.({ host: hosts(), bytes: 0 });
      armHedge();
      const t0 = Date.now();
      const sig = AbortSignal.any([ctrl.signal, AbortSignal.timeout(attemptMs)]);
      (async () => {
        const res = await fetchImpl(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: sig,
        });
        if (res.status === 429) {
          const w = await slotWait(url, fetchImpl);
          if (w != null) waitSecs = Math.min(waitSecs ?? Infinity, w);
          throw new Error(`busy${w ? ` (next free slot in ${w} s)` : ''}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await readJSON(res, (bytes) => !done && onStatus?.({ host, bytes }));
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark.trim().slice(0, 120));
        return json.elements ?? [];
      })().then(
        (elements) => {
          recordResult(stats, host, true, Date.now() - t0);
          running.delete(host);
          finish(resolve, elements);
        },
        (err) => {
          running.delete(host);
          if (done) return;
          recordResult(stats, host, false, 0);
          errors.push(`${host}: ${err.name === 'TimeoutError' ? 'no answer' : err.message}`);
          if (queue.length) launch(); // try the next server straight away
          else if (!running.size) finish(reject, Object.assign(new Error(errors.join('; ')), { waitSecs }));
          else onStatus?.({ host: hosts(), bytes: 0 });
        },
      );
    }
    launch();
  });
}

// Run one Overpass query: from the browser cache if possible, otherwise race
// the servers. If every server fails, wait (as long as the busiest server asks,
// or 5 s then 10 s) and try once or twice more.
export async function runQuery(query, { signal, onStatus, fetchImpl, hedgeMs, attemptMs } = {}) {
  const cached = await cacheGet(query);
  if (cached) {
    onStatus?.({ cached: true, bytes: 0 });
    return cached;
  }
  const stats = loadStats();
  let last;
  for (let round = 0; round < 3; round++) {
    if (round) {
      const secs = Math.min(60, Math.max(5 * round, last?.waitSecs ?? 0));
      onStatus?.({ retryIn: secs, bytes: 0 });
      await wait(secs * 1000, signal);
    }
    try {
      const elements = await raceServers(query, rankEndpoints(OVERPASS_ENDPOINTS, stats), { signal, onStatus, fetchImpl, hedgeMs, attemptMs, stats });
      saveStats(stats);
      cachePut(query, elements);
      return elements;
    } catch (err) {
      saveStats(stats);
      if (signal?.aborted) throw err;
      last = err;
    }
  }
  throw new Error(`all Overpass servers are busy or failing (${last?.message ?? 'unknown error'})`);
}

// Download everything requested for a bbox. `opts.buildings` is
// 'footprints' | 'light' | 'none'. `onProgress(part, status)` reports per request.
export async function loadOSM(bbox, opts, { signal, onProgress } = {}) {
  const jobs = [];
  if (opts.buildings !== 'none') {
    jobs.push(runQuery(buildingsQuery(bbox, opts.buildings === 'light'), { signal, onStatus: (s) => onProgress?.('buildings', s) }));
  }
  if (opts.roads || opts.paths || opts.waterways || opts.facilities) {
    jobs.push(runQuery(networkQuery(bbox, opts), { signal, onStatus: (s) => onProgress?.('network', s) }));
  }
  const parts = await Promise.all(jobs);
  return parseOSM(parts.flat());
}

// ---- Classification -----------------------------------------------------------

// Eight categorical groups (validated palette order) plus a neutral "other".
export const FACILITY_GROUPS = {
  health: { label: 'Health', color: '#e34948' },
  education: { label: 'Education', color: '#6250d6' },
  emergency: { label: 'Emergency services & shelter', color: '#008300' },
  community: { label: 'Government, community & heritage', color: '#e87ba4' },
  utilities: { label: 'Water, power & telecom', color: '#1baf7a' },
  transport: { label: 'Transport hubs & bridges', color: '#eda100' },
  economic: { label: 'Markets, shops, finance & hotels', color: '#2a78d6' },
  hazardous: { label: 'Hazardous sites', color: '#eb6834' },
  other: { label: 'Other amenities', color: '#898781' },
};
// Groups reported as "critical facilities" in the exposure and risk results.
export const CRITICAL_GROUPS = new Set(['health', 'education', 'emergency', 'community', 'utilities', 'transport', 'hazardous']);

const set = (s) => new Set(s.split(' '));
const A_HEALTH = set('hospital clinic doctors pharmacy dentist health_post nursing_home baby_hatch');
const A_EDU = set('school kindergarten college university childcare library training');
const A_EMERG = set('fire_station police shelter ranger_station refugee_site emergency_service');
const A_COMM = set('townhall courthouse community_centre place_of_worship social_facility social_centre post_office prison embassy arts_centre');
const A_UTIL = set('drinking_water water_point toilets shower');
const A_TRANS = set('bus_station ferry_terminal');
const A_HAZ = set('fuel');
const A_ECON = set('marketplace bank atm bureau_de_change money_transfer');
const MM_UTIL = set('water_tower water_works wastewater_plant water_well reservoir_covered pumping_station mast communications_tower dyke embankment');
const MM_HAZ = set('storage_tank works petroleum_well gasometer silo');

function classifyFacility(t) {
  const a = t.amenity;
  if (A_HEALTH.has(a) || t.healthcare) return ['health', A_HEALTH.has(a) ? a : t.healthcare];
  if (A_EDU.has(a)) return ['education', a];
  if (A_EMERG.has(a)) return ['emergency', a];
  if (t.emergency) return ['emergency', t.emergency];
  if (t.leisure === 'park' || t.leisure === 'stadium') return ['emergency', `${t.leisure} (open space)`];
  if (A_COMM.has(a)) return ['community', a];
  if (t.office) return ['community', `${t.office} office`];
  if (t.historic || t.heritage || t.tourism === 'museum') return ['community', t.tourism === 'museum' ? 'museum' : `heritage: ${t.historic ?? 'site'}`];
  if (A_UTIL.has(a)) return ['utilities', a];
  if (t.power) return ['utilities', `power ${t.power}`];
  if (MM_UTIL.has(t.man_made)) return ['utilities', t.man_made];
  if (t.telecom) return ['utilities', `telecom ${t.telecom}`];
  if (A_TRANS.has(a)) return ['transport', a];
  if (t.railway) return ['transport', `railway ${t.railway}`];
  if (t.aeroway) return ['transport', t.aeroway];
  if (A_HAZ.has(a)) return ['hazardous', 'fuel station'];
  if (MM_HAZ.has(t.man_made)) return ['hazardous', t.man_made];
  if (A_ECON.has(a)) return ['economic', a];
  if (t.shop) return ['economic', t.shop === 'yes' ? 'shop' : `shop: ${t.shop}`];
  if (t.tourism) return ['economic', t.tourism];
  if (a) return ['other', a];
  return null;
}

const B_RES = set('house residential apartments detached semidetached_house terrace hut bungalow dormitory farm cabin static_caravan houseboat ger stilt_house');
const B_COM = set('commercial retail office shop hotel kiosk supermarket');
const B_IND = set('industrial warehouse factory manufacture hangar');
const B_PUB = set('school hospital university college public civic government church mosque temple kindergarten train_station transportation fire_station chapel cathedral shrine monastery synagogue stadium sports_hall pavilion');
const B_ANC = set('shed garage garages roof greenhouse barn stable cowshed carport construction ruins service farm_auxiliary sty boathouse bunker container tent toilets');

export const BUILDING_CLASSES = {
  residential: 'Residential',
  commercial: 'Commercial',
  industrial: 'Industrial',
  public: 'Public',
  ancillary: 'Sheds, garages & other',
  unknown: 'Untagged (building=yes)',
};

export function buildingClass(t) {
  const b = t.building;
  if (B_RES.has(b)) return 'residential';
  if (B_COM.has(b)) return 'commercial';
  if (B_IND.has(b)) return 'industrial';
  if (B_PUB.has(b)) return 'public';
  if (B_ANC.has(b)) return 'ancillary';
  if (t.amenity || t.healthcare) return 'public';
  if (t.shop || t.office || t.tourism) return 'commercial';
  if (t.craft || t.industrial || t.man_made) return 'industrial';
  return 'unknown';
}

function roadClass(hw) {
  if (/^(motorway|trunk|primary|secondary|tertiary)(_link)?$/.test(hw)) return 'major';
  if (/^(footway|path|pedestrian|cycleway|steps|bridleway)$/.test(hw)) return 'path';
  return 'minor';
}

function waterClass(ww) {
  return /^(river|canal|tidal_channel)$/.test(ww) ? 'river' : 'stream';
}

// ---- Geometry -------------------------------------------------------------------

function wayCoords(el) {
  if (!el.geometry) return null;
  const c = el.geometry.filter(Boolean).map((p) => [p.lon, p.lat]);
  return c.length >= 2 ? c : null;
}

function isClosed(c) {
  return c.length >= 4 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
}

function ringCentroid(c) {
  const n = isClosed(c) ? c.length - 1 : c.length;
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += c[i][0];
    y += c[i][1];
  }
  return [x / n, y / n];
}

function feature(geometry, center, props) {
  return { type: 'Feature', geometry, center, properties: props };
}

function parseLevels(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 && n < 200 ? n : null;
}

// Turn Overpass elements into four feature arrays. Each feature also carries a
// `center` [lon, lat] used for point-based analysis.
export function parseOSM(elements) {
  const out = { buildings: [], facilities: [], waterways: [], roads: [] };
  const seenBuildings = new Set();
  const seenFacilities = new Set();
  let fid = 0;
  for (const el of elements) {
    const t = el.tags ?? {};
    const osm_id = `${el.type}/${el.id}`;
    const name = t.name ?? t['name:en'] ?? '';
    let coords = null;
    let pt = null;
    let area = null;
    let bbox = null;
    if (el.type === 'node') pt = [el.lon, el.lat];
    else if (el.geometry) coords = wayCoords(el);
    else if (el.bounds) {
      // Light mode: bounding box only. Footprints fill ~70% of their box on average.
      const { minlat, minlon, maxlat, maxlon } = el.bounds;
      bbox = [minlon, minlat, maxlon, maxlat];
      pt = [(minlon + maxlon) / 2, (minlat + maxlat) / 2];
      area = 0.7 * lonLatArea([[minlon, minlat], [maxlon, minlat], [maxlon, maxlat], [minlon, maxlat]]);
    } else if (el.center) pt = [el.center.lon, el.center.lat];
    if (!pt && !coords) continue;

    const closed = coords && isClosed(coords);
    const center = pt ?? ringCentroid(coords);
    const asPoint = { type: 'Point', coordinates: center };

    if (t.building && t.building !== 'no' && el.type !== 'node' && !seenBuildings.has(osm_id)) {
      seenBuildings.add(osm_id);
      if (closed) area = lonLatArea(coords);
      out.buildings.push(feature(closed ? { type: 'Polygon', coordinates: [coords] } : asPoint, center, {
        fid: ++fid, osm_id, kind: 'building', cls: buildingClass(t), type: t.building === 'yes' ? 'building' : t.building, name,
        levels: parseLevels(t['building:levels']), area: area ? Math.round(area) : null,
        material: t['building:material'] ?? t['building:structure'] ?? t['building:walls'] ?? '',
        ...(bbox ? { bbox } : {}),
      }));
      continue; // Building tags arrive with the buildings query; facilities come from the network query.
    }
    if (el.type === 'way' && coords && (t.waterway || t.highway)) {
      if (t.waterway) {
        out.waterways.push(feature({ type: 'LineString', coordinates: coords }, center, {
          fid: ++fid, osm_id, kind: 'water', type: t.waterway, cls: waterClass(t.waterway), name,
        }));
        continue;
      }
      if (t.highway) {
        out.roads.push(feature({ type: 'LineString', coordinates: coords }, center, {
          fid: ++fid, osm_id, kind: 'road', type: t.highway, cls: roadClass(t.highway), name, bridge: !!(t.bridge && t.bridge !== 'no'),
        }));
        if (t.bridge && t.bridge !== 'no' && roadClass(t.highway) !== 'path') {
          const mid = coords[Math.floor(coords.length / 2)];
          out.facilities.push(feature({ type: 'Point', coordinates: mid }, mid, {
            fid: ++fid, osm_id, kind: 'facility', group: 'transport', type: `bridge (${t.highway.replace(/_/g, ' ')})`, name,
          }));
        }
        continue;
      }
    }
    const fc = classifyFacility(t);
    if (fc && !seenFacilities.has(osm_id)) {
      seenFacilities.add(osm_id);
      out.facilities.push(feature(asPoint, center, { fid: ++fid, osm_id, kind: 'facility', group: fc[0], type: fc[1], name }));
    }
  }
  return out;
}
