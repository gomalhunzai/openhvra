// OpenHVRA project files (.openhvra): saving the area, every setting and input,
// and optionally the downloaded data, so a piece of work can be reopened later,
// shared with colleagues and reproduced.
//
// A project file is UTF-8 JSON, gzip-compressed (like QGIS .qgz files), with a
// fixed `format` marker and a `schemaVersion` for the file layout. Plain
// (uncompressed) JSON with the same content opens too. Everything read from a
// file is treated as untrusted: it is checked here before the app uses it.
//
// This module has no browser UI, so it can be tested in Node.

export const PROJECT_FORMAT = 'openhvra-project';
export const SCHEMA_VERSION = 1;
export const PROJECT_EXT = '.openhvra';
export const PROJECT_MIME = 'application/x-openhvra+gzip';
export const MAX_PROJECT_BYTES = 500e6; // decompressed size refused above this

export class ProjectError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectError';
  }
}

// ---- Versions ---------------------------------------------------------------------------------

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// -1, 0 or 1, comparing major.minor.patch.
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// What a user should know about a file made with another version of the app.
// Versions follow the CHANGELOG rule: before 1.0, a new minor number means a
// method changed (results may differ); a new patch number means they did not.
export function versionNote(fileVersion, appVersion) {
  const f = parseVersion(fileVersion);
  const a = parseVersion(appVersion);
  if (!f || !a) return { level: 'warn', text: 'The project does not say which version of OpenHVRA made it, so results may differ from when it was saved.' };
  const cmp = compareVersions(fileVersion, appVersion);
  if (cmp === 0) return { level: 'ok', text: '' };
  if (cmp > 0) {
    return { level: 'warn', text: `The project was saved with a newer version of OpenHVRA (${fileVersion}) than this one (${appVersion}). Settings this version does not know are ignored, and results may differ.` };
  }
  const methodChange = f[0] !== a[0] || (a[0] === 0 && f[1] !== a[1]);
  return methodChange
    ? { level: 'warn', text: `The project was saved with OpenHVRA ${fileVersion}. Methods have changed since then (see the CHANGELOG), so results may differ from when it was saved.` }
    : { level: 'info', text: `The project was saved with OpenHVRA ${fileVersion}. Only fixes have been made since then, so results are unchanged.` };
}

// ---- Compression ------------------------------------------------------------------------------

async function streamBytes(stream, limit = Infinity) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new ProjectError(`the project is too large to open (over ${Math.round(limit / 1e6)} MB uncompressed)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// The project as gzip-compressed JSON bytes.
export async function encodeProject(doc) {
  const text = JSON.stringify(doc);
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return streamBytes(stream);
}

// Bytes of a project file (gzip or plain JSON) → parsed object, not yet checked.
export async function decodeProject(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = u8;
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    try {
      raw = await streamBytes(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_PROJECT_BYTES);
    } catch (err) {
      if (err instanceof ProjectError) throw err;
      throw new ProjectError('the file is damaged (it could not be decompressed)');
    }
  } else if (u8.length > MAX_PROJECT_BYTES) {
    throw new ProjectError(`the project is too large to open (over ${Math.round(MAX_PROJECT_BYTES / 1e6)} MB)`);
  }
  let text = new TextDecoder('utf-8').decode(raw);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProjectError('this is not an OpenHVRA project file (it is not valid JSON)');
  }
}

// ---- File names -------------------------------------------------------------------------------

export function projectFileName(name, date = new Date()) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  const d = date.toISOString().slice(0, 10);
  return `${slug || 'openhvra-project'}-${d}${PROJECT_EXT}`;
}

// ---- Checking a file ------------------------------------------------------------------------------

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isLonLat = (p) => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const isRing = (r) => Array.isArray(r) && r.length >= 4 && r.every(isLonLat);
const isLine = (l) => Array.isArray(l) && l.length >= 2 && l.every(isLonLat);
const isBBox = (b) => Array.isArray(b) && b.length === 4 && b.every(isNum) && b[0] < b[2] && b[1] < b[3] && isLonLat([b[0], b[1]]) && isLonLat([b[2], b[3]]);
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

// Upgrades older file layouts to the current one. Add a step here whenever
// SCHEMA_VERSION goes up, so old files keep opening.
const MIGRATIONS = {
  // 1: (doc) => ({ ...doc, schemaVersion: 2, ... }),
};

export function migrateProject(doc) {
  let d = doc;
  while (d.schemaVersion < SCHEMA_VERSION) {
    const step = MIGRATIONS[d.schemaVersion];
    if (!step) throw new ProjectError(`project files of layout version ${d.schemaVersion} can no longer be opened`);
    d = step(d);
  }
  return d;
}

function checkArea(a) {
  if (a == null) return null;
  if (!isObj(a) || !Array.isArray(a.polygons) || !a.polygons.length) throw new ProjectError('the area in the project is not valid');
  for (const poly of a.polygons) {
    if (!Array.isArray(poly) || !poly.length || !poly.every(isRing)) throw new ProjectError('the area in the project has an invalid outline');
  }
  const type = ['rect', 'circle', 'polygon', 'upload'].includes(a.type) ? a.type : 'polygon';
  const out = { type, polygons: a.polygons.map((p) => p.map((r) => r.map(([x, y]) => [x, y]))) };
  if (a.name) out.name = str(a.name, 200);
  if (isNum(a.radius) && a.radius > 0) out.radius = a.radius;
  if (a.usedBBox === true) out.usedBBox = true;
  return out;
}

// Settings are { elementId: value }; only primitive values are kept here, and
// the app checks each against its own control (type, options, limits).
function checkControls(c) {
  if (!isObj(c)) return {};
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (!/^[A-Za-z][\w-]{0,60}$/.test(k)) continue;
    if (typeof v === 'boolean' || isNum(v) || v === null) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
  }
  return out;
}

const GEOM_TYPES = new Set(['Point', 'LineString', 'Polygon', 'MultiPolygon']);
function isFeature(f) {
  return isObj(f) && isObj(f.geometry) && GEOM_TYPES.has(f.geometry.type) && Array.isArray(f.geometry.coordinates) &&
    isLonLat(f.center) && isObj(f.properties) && isNum(f.properties.fid);
}
function checkFeatures(list, what) {
  if (!Array.isArray(list)) throw new ProjectError(`the saved ${what} are not valid`);
  if (!list.every(isFeature)) throw new ProjectError(`some saved ${what} are not valid`);
  return list;
}

function checkData(d) {
  if (!isObj(d)) throw new ProjectError('the saved data is not valid');
  if (!isBBox(d.bbox)) throw new ProjectError('the saved data has no valid extent');
  if (!isObj(d.loadOpts)) throw new ProjectError('the saved data does not say what was downloaded');
  const o = d.loadOpts;
  const loadOpts = {
    buildings: ['footprints', 'light', 'none'].includes(o.buildings) ? o.buildings : 'none',
    facilities: !!o.facilities, waterways: !!o.waterways, roads: !!o.roads, paths: !!o.paths,
  };
  let osm = null;
  if (d.osm != null) {
    if (!isObj(d.osm)) throw new ProjectError('the saved OpenStreetMap data is not valid');
    osm = {
      buildings: checkFeatures(d.osm.buildings ?? [], 'buildings'),
      facilities: checkFeatures(d.osm.facilities ?? [], 'facilities'),
      waterways: checkFeatures(d.osm.waterways ?? [], 'waterways'),
      roads: checkFeatures(d.osm.roads ?? [], 'roads'),
    };
  }
  const added = {};
  for (const kind of ['buildings', 'facilities']) {
    const a = d.added?.[kind];
    if (!isObj(a)) continue;
    added[kind] = { auto: !!a.auto, ...(a.features != null ? { features: checkFeatures(a.features, `added ${kind}`) } : {}), meta: isObj(a.meta) ? a.meta : {} };
  }
  return { bbox: d.bbox.slice(), aoi: checkArea(d.aoi), loadOpts, downloadedAt: str(d.downloadedAt, 40), osm, added };
}

function checkMarks(m) {
  const out = { lakes: [], glaciers: [], paths: {} };
  if (!isObj(m)) return out;
  for (const l of Array.isArray(m.lakes) ? m.lakes : []) {
    if (!isObj(l) || typeof l.id !== 'string' || !isNum(l.area) || l.area <= 0) continue;
    if (l.kind === 'point' && isLonLat(l.point)) out.lakes.push({ id: str(l.id, 40), kind: 'point', point: l.point.slice(0, 2), area: l.area });
    else if (l.kind !== 'point' && isRing(l.ring)) out.lakes.push({ id: str(l.id, 40), kind: 'outline', ring: l.ring, area: l.area });
  }
  for (const g of Array.isArray(m.glaciers) ? m.glaciers : []) {
    if (isObj(g) && typeof g.id === 'string' && isRing(g.ring) && isNum(g.area)) out.glaciers.push({ id: str(g.id, 40), ring: g.ring, area: g.area });
  }
  if (isObj(m.paths)) for (const [id, line] of Object.entries(m.paths)) if (isLine(line)) out.paths[str(id, 60)] = line;
  return out;
}

function checkLakes(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((l) => isObj(l) && isNum(l.lon) && isNum(l.lat) && isLonLat([l.lon, l.lat]) && isNum(l.area) && l.area > 0)
    .map((l) => ({
      id: str(l.id, 40), name: str(l.name, 200), source: str(l.source, 200), lon: l.lon, lat: l.lat, area: l.area,
      ...(Array.isArray(l.outline) && l.outline.every(isRing) ? { outline: l.outline } : {}),
    }));
}

function checkCensus(c) {
  if (!isObj(c) || !Array.isArray(c.features) || !c.features.length) return null;
  const features = c.features.filter((f) => isObj(f) && isObj(f.geometry) && ['Polygon', 'MultiPolygon'].includes(f.geometry.type));
  if (!features.length) return null;
  return { name: str(c.name, 200), field: str(c.field, 200), higher: c.higher !== false, features };
}

// Checks a decoded file and returns a clean project the app can apply, plus
// warnings for the user. Throws ProjectError with a readable message.
export function readProject(doc, appVersion) {
  if (!isObj(doc) || doc.format !== PROJECT_FORMAT) throw new ProjectError('this is not an OpenHVRA project file');
  if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1) throw new ProjectError('the project file has no valid layout version');
  if (doc.schemaVersion > SCHEMA_VERSION) {
    throw new ProjectError(`the project was saved by a newer version of OpenHVRA (${str(doc.app?.version, 20) || 'unknown'}) in a layout this version cannot read. Open it in the latest version at https://gomalhunzai.github.io/openhvra/`);
  }
  const d = migrateProject(doc);
  const warnings = [];
  const v = versionNote(d.app?.version, appVersion);
  if (v.text) warnings.push(v);

  const project = {
    name: str(d.name, 120),
    appVersion: str(d.app?.version, 20),
    created: str(d.created, 40),
    modified: str(d.modified, 40),
    area: checkArea(d.area),
    controls: checkControls(d.settings?.controls),
    scenarios: Array.isArray(d.settings?.floodScenarios)
      ? d.settings.floodScenarios.filter((s) => isObj(s) && isNum(s.rp) && isNum(s.level)).map((s) => ({ rp: s.rp, level: s.level }))
      : null,
    hazards: isObj(d.settings?.hazards) ? d.settings.hazards : null,
    sviIndicators: Array.isArray(d.settings?.sviIndicators) ? d.settings.sviIndicators.filter((k) => typeof k === 'string') : null,
    costInfo: isObj(d.settings?.costInfo) ? d.settings.costInfo : null,
    marks: checkMarks(d.inputs?.marks),
    lakeUploads: checkLakes(d.inputs?.lakeUploads),
    census: checkCensus(d.inputs?.census),
    view: isObj(d.view) ? d.view : null,
    steps: isObj(d.steps) ? { exposure: !!d.steps.exposure, risk: !!d.steps.risk, svi: !!d.steps.svi, mh: !!d.steps.mh } : {},
    display: isObj(d.display) ? d.display : {},
    data: null,
  };
  if (!project.area && !d.data) throw new ProjectError('the project has neither an area nor saved data');
  if (d.data != null) {
    try {
      project.data = checkData(d.data);
    } catch (err) {
      if (!(err instanceof ProjectError)) throw err;
      warnings.push({ level: 'warn', text: `The saved data could not be used (${err.message}), so it will be downloaded again.` });
      project.data = null;
      if (isBBox(d.data?.bbox) && isObj(d.data?.loadOpts)) project.redownload = { bbox: d.data.bbox.slice() };
    }
  }
  if (!project.area && project.data) project.area = bboxArea(project.data.bbox);
  if (!project.area && project.redownload) project.area = bboxArea(project.redownload.bbox);
  if (!project.area) throw new ProjectError('the project has no usable area');
  return { project, warnings };
}

// A rectangle area from a bounding box (used when the work was done on the map view).
export function bboxArea([w, s, e, n], name = 'Map view when saved') {
  return { type: 'rect', name, polygons: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]] };
}

// The document written to a file. `parts` come from the app (see ui/project.js).
export function buildProject(parts, { appVersion, repo, now = new Date() } = {}) {
  const iso = now.toISOString();
  return {
    format: PROJECT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    app: { name: 'OpenHVRA', version: appVersion, url: repo },
    name: parts.name ?? '',
    created: parts.created || iso,
    modified: iso,
    area: parts.area,
    view: parts.view ?? null,
    settings: parts.settings,
    inputs: parts.inputs,
    steps: parts.steps ?? {},
    display: parts.display ?? {},
    data: parts.data ?? null,
    notice: 'OpenHVRA project file. Open it at https://gomalhunzai.github.io/openhvra/ (Open project). OpenStreetMap data © OpenStreetMap contributors, ODbL; added buildings and places © Overture Maps Foundation and contributors (see the app for licences).',
  };
}
