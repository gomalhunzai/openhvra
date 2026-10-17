// Read an area-of-interest boundary from common spatial file formats:
// zipped or loose Shapefile (.shp + .dbf + .prj), GeoJSON, TopoJSON, KML, KMZ,
// GPX, GeoPackage and WKT. Parsing libraries are only downloaded the first
// time a format is used, keeping the app itself light.

import { makeProjection } from './spatial.js';

const NPM = 'https://cdn.jsdelivr.net/npm';
const LIBS = {
  shp: `${NPM}/shpjs@6.1.0/+esm`,
  togeojson: `${NPM}/@tmcw/togeojson@5.8.1/+esm`,
  fflate: `${NPM}/fflate@0.8.2/+esm`,
  proj4: `${NPM}/proj4@2.12.1/+esm`,
  topojson: `${NPM}/topojson-client@3.1.0/+esm`,
  wellknown: `${NPM}/wellknown@0.5.0/+esm`,
};
const SQLJS = `${NPM}/sql.js@1.10.3/dist`;

export const ACCEPT = '.zip,.shp,.dbf,.prj,.cpg,.shx,.geojson,.json,.topojson,.kml,.kmz,.gpx,.gpkg,.wkt,.txt';

const ext = (name) => name.toLowerCase().split('.').pop();

// ---- Entry point --------------------------------------------------------------------------

// Returns { features, format }. Features are GeoJSON in WGS84 lon/lat.
export async function readSpatialFiles(fileList) {
  const files = [...fileList];
  if (!files.length) throw new Error('no file selected');
  const shp = files.find((f) => ext(f.name) === 'shp');
  if (shp) return { features: await readLooseShapefile(files, shp), format: 'Shapefile' };
  const f = files[0];
  return readBuffer(f.name, await f.arrayBuffer());
}

async function readBuffer(name, buf) {
  const e = ext(name);
  if (e === 'zip') return readZip(buf);
  if (e === 'kmz') return readKmz(buf);
  if (e === 'kml') return { features: await readXml(text(buf), 'kml'), format: 'KML' };
  if (e === 'gpx') return { features: await readXml(text(buf), 'gpx'), format: 'GPX' };
  if (e === 'gpkg') return { features: await readGpkg(buf), format: 'GeoPackage' };
  if (e === 'wkt' || e === 'txt') return { features: await readWkt(text(buf)), format: 'WKT' };
  if (e === 'geojson' || e === 'json' || e === 'topojson') return readJson(text(buf));
  throw new Error(`unsupported file type ".${e}". Use a zipped Shapefile, GeoJSON, KML, KMZ, GPX, GeoPackage or WKT.`);
}

function text(buf) {
  return new TextDecoder().decode(buf);
}

// ---- Formats ------------------------------------------------------------------------------

async function readZip(buf) {
  const { unzipSync } = await import(LIBS.fflate);
  const entries = unzipSync(new Uint8Array(buf));
  const names = Object.keys(entries).filter((n) => !n.startsWith('__MACOSX') && !n.endsWith('/'));
  if (names.some((n) => ext(n) === 'shp')) {
    const { parseZip } = await import(LIBS.shp);
    const out = await parseZip(buf);
    return { features: (Array.isArray(out) ? out : [out]).flatMap((fc) => fc.features), format: 'Shapefile (zip)' };
  }
  const inner = names.find((n) => ['geojson', 'json', 'topojson', 'kml', 'gpx', 'gpkg', 'wkt'].includes(ext(n)));
  if (!inner) throw new Error('the zip contains no Shapefile, GeoJSON, KML, GPX, GeoPackage or WKT file');
  const bytes = entries[inner];
  return readBuffer(inner, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function readKmz(buf) {
  const { unzipSync } = await import(LIBS.fflate);
  const entries = unzipSync(new Uint8Array(buf));
  const kml = Object.keys(entries).find((n) => ext(n) === 'kml');
  if (!kml) throw new Error('the KMZ contains no KML document');
  return { features: await readXml(new TextDecoder().decode(entries[kml]), 'kml'), format: 'KMZ' };
}

async function readLooseShapefile(files, shpFile) {
  const { parseShp, parseDbf, combine } = await import(LIBS.shp);
  const base = shpFile.name.replace(/\.shp$/i, '').toLowerCase();
  const sibling = (e) => files.find((f) => f.name.toLowerCase() === `${base}.${e}`) ?? files.find((f) => ext(f.name) === e);
  const prj = sibling('prj');
  const dbf = sibling('dbf');
  const cpg = sibling('cpg');
  const geoms = parseShp(await shpFile.arrayBuffer(), prj ? await prj.text() : undefined);
  const features = dbf
    ? combine([geoms, parseDbf(await dbf.arrayBuffer(), cpg ? await cpg.text() : undefined)]).features
    : geoms.map((g) => ({ type: 'Feature', properties: {}, geometry: g }));
  if (!prj) assertLonLat(features, 'Shapefile has no .prj file and its coordinates are not longitude/latitude. Include the .prj file.');
  return features;
}

async function readXml(src, kind) {
  const tg = await import(LIBS.togeojson);
  const doc = new DOMParser().parseFromString(src, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error(`the ${kind.toUpperCase()} file is not valid XML`);
  return tg[kind](doc).features;
}

async function readJson(src) {
  let json;
  try {
    json = JSON.parse(src);
  } catch {
    throw new Error('the file is not valid JSON');
  }
  if (json.type === 'Topology') {
    const { feature } = await import(LIBS.topojson);
    return { features: Object.values(json.objects).flatMap((o) => toFeatures(feature(json, o))), format: 'TopoJSON' };
  }
  let features = toFeatures(json);
  const crs = json.crs?.properties?.name;
  if (crs && !/CRS84|4326/.test(crs)) features = await reproject(features, crsToProj(crs));
  assertLonLat(features, 'coordinates are not longitude/latitude. Save the file in WGS84 (EPSG:4326).');
  return { features, format: 'GeoJSON' };
}

async function readWkt(src) {
  const { parse } = await import(LIBS.wellknown);
  const features = src.split(/\n(?=\s*[A-Za-z])/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const g = parse(s.replace(/^SRID=\d+;/i, ''));
    if (!g) throw new Error('could not parse the WKT text');
    return { type: 'Feature', properties: {}, geometry: g };
  });
  assertLonLat(features, 'WKT coordinates are not longitude/latitude. Use WGS84 (EPSG:4326).');
  return features;
}

// GeoPackage: SQLite file; geometries are a small header followed by WKB.
async function readGpkg(buf) {
  if (!window.initSqlJs) {
    await new Promise((resolve, reject) => {
      const s = Object.assign(document.createElement('script'), { src: `${SQLJS}/sql-wasm.js`, onload: resolve, onerror: () => reject(new Error('could not load the GeoPackage reader')) });
      document.head.appendChild(s);
    });
  }
  const SQL = await window.initSqlJs({ locateFile: (f) => `${SQLJS}/${f}` });
  const db = new SQL.Database(new Uint8Array(buf));
  try {
    const layers = db.exec("SELECT g.table_name, g.column_name, g.srs_id FROM gpkg_geometry_columns g JOIN gpkg_contents c USING (table_name) WHERE c.data_type = 'features'");
    if (!layers.length) throw new Error('the GeoPackage has no feature layers');
    const [table, column, srsId] = layers[0].values[0];
    const res = db.exec(`SELECT * FROM "${table.replace(/"/g, '""')}"`)[0];
    if (!res) throw new Error('the GeoPackage layer is empty');
    const gi = res.columns.indexOf(column);
    let features = res.values.map((row) => {
      const properties = {};
      res.columns.forEach((c, i) => {
        if (i !== gi && !(row[i] instanceof Uint8Array)) properties[c] = row[i];
      });
      return { type: 'Feature', properties, geometry: row[gi] ? gpkgGeometry(row[gi]) : null };
    }).filter((f) => f.geometry);
    if (srsId !== 4326 && srsId > 0) {
      const def = db.exec(`SELECT definition, organization, organization_coordsys_id FROM gpkg_spatial_ref_sys WHERE srs_id = ${Number(srsId)}`)[0]?.values[0];
      const proj = def && (def[1]?.toUpperCase() === 'EPSG' && knownEpsg(def[2])) || def?.[0];
      if (!proj) throw new Error(`unknown coordinate system (srs_id ${srsId})`);
      features = await reproject(features, proj);
    }
    return features;
  } finally {
    db.close();
  }
}

function gpkgGeometry(blob) {
  const flags = blob[3];
  const envelope = [0, 32, 48, 48, 64][(flags >> 1) & 7] ?? 0;
  if ((flags >> 4) & 1) return null; // empty geometry
  return readWKB(new DataView(blob.buffer, blob.byteOffset + 8 + envelope));
}

function readWKB(view) {
  let o = 0;
  const geom = () => {
    const le = view.getUint8(o) === 1;
    o += 1;
    let type = view.getUint32(o, le);
    o += 4;
    let dims = 2;
    if (type & 0x80000000) dims++; // EWKB Z
    if (type & 0x40000000) dims++; // EWKB M
    if (type & 0x20000000) o += 4; // EWKB SRID
    type &= 0x0fffffff;
    if (type > 3000) { dims = 4; type -= 3000; } else if (type > 2000) { dims = 3; type -= 2000; } else if (type > 1000) { dims = 3; type -= 1000; }
    const u32 = () => { const v = view.getUint32(o, le); o += 4; return v; };
    const pt = () => { const c = [view.getFloat64(o, le), view.getFloat64(o + 8, le)]; o += 8 * dims; return c; };
    const pts = () => Array.from({ length: u32() }, pt);
    const rings = () => Array.from({ length: u32() }, pts);
    const many = () => Array.from({ length: u32() }, geom);
    switch (type) {
      case 1: return { type: 'Point', coordinates: pt() };
      case 2: return { type: 'LineString', coordinates: pts() };
      case 3: return { type: 'Polygon', coordinates: rings() };
      case 4: return { type: 'MultiPoint', coordinates: many().map((g) => g.coordinates) };
      case 5: return { type: 'MultiLineString', coordinates: many().map((g) => g.coordinates) };
      case 6: return { type: 'MultiPolygon', coordinates: many().map((g) => g.coordinates) };
      case 7: return { type: 'GeometryCollection', geometries: many() };
      default: throw new Error(`unsupported geometry type ${type} in GeoPackage`);
    }
  };
  return geom();
}

// ---- Coordinate systems -------------------------------------------------------------------

function knownEpsg(code) {
  code = Number(code);
  if (code === 4326) return 'EPSG:4326';
  if (code === 3857 || code === 900913 || code === 102100) return 'EPSG:3857';
  if (code >= 32601 && code <= 32660) return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  if (code >= 32701 && code <= 32760) return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  return null;
}

function crsToProj(name) {
  const code = name.match(/(\d{4,6})\s*$/)?.[1];
  const proj = code && knownEpsg(code);
  if (!proj) throw new Error(`unsupported coordinate system ${name}. Save the file in WGS84 (EPSG:4326).`);
  return proj;
}

async function reproject(features, from) {
  const proj4 = (await import(LIBS.proj4)).default;
  const tr = proj4(from, 'EPSG:4326');
  const walk = (c) => (typeof c[0] === 'number' ? tr.forward([c[0], c[1]]) : c.map(walk));
  const geom = (g) => (g.type === 'GeometryCollection' ? { ...g, geometries: g.geometries.map(geom) } : { ...g, coordinates: walk(g.coordinates) });
  return features.map((f) => ({ ...f, geometry: f.geometry && geom(f.geometry) }));
}

function assertLonLat(features, message) {
  for (const f of features) {
    let bad = false;
    eachCoord(f.geometry, ([x, y]) => (bad ||= Math.abs(x) > 180 || Math.abs(y) > 90));
    if (bad) throw new Error(message);
  }
}

// ---- Geometry helpers ---------------------------------------------------------------------

function toFeatures(gj) {
  if (!gj) return [];
  if (gj.type === 'FeatureCollection') return gj.features.filter((f) => f.geometry);
  if (gj.type === 'Feature') return gj.geometry ? [gj] : [];
  if (gj.type) return [{ type: 'Feature', properties: {}, geometry: gj }];
  return [];
}

function eachCoord(g, cb) {
  if (!g) return;
  if (g.type === 'GeometryCollection') return g.geometries.forEach((x) => eachCoord(x, cb));
  const walk = (c) => (typeof c[0] === 'number' ? cb(c) : c.forEach(walk));
  walk(g.coordinates);
}

// Polygons of a geometry as [[outer, ...holes], ...].
function polygonsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  if (g.type === 'GeometryCollection') return g.geometries.flatMap(polygonsOf);
  return [];
}

export function featureLabel(f, i) {
  const props = f.properties ?? {};
  const key = Object.keys(props).find((k) => /^(name|name_en|nom|nombre|shapename|admin|district|label|title)$/i.test(k))
    ?? Object.keys(props).find((k) => /name/i.test(k) && typeof props[k] === 'string');
  return key && props[key] ? String(props[key]) : `Feature ${i + 1}`;
}

export function polygonFeatures(features) {
  return features.filter((f) => polygonsOf(f.geometry).length);
}

// Turn features into AOI polygons. Without polygons, the bounding box of all
// coordinates is used. Detailed boundaries are simplified to ≤ 5000 vertices
// so point-in-area tests stay fast.
export function toAoiPolygons(features) {
  let polys = features.flatMap((f) => polygonsOf(f.geometry)).filter((p) => p[0]?.length >= 4);
  let usedBBox = false;
  if (!polys.length) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const f of features) eachCoord(f.geometry, ([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); });
    if (!Number.isFinite(w)) throw new Error('the file contains no geometry');
    if (e - w < 1e-4 || n - s < 1e-4) throw new Error('the file contains a single point; an area is needed');
    polys = [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]];
    usedBBox = true;
  }
  const rings = polys.flat();
  const [lon0, lat0] = rings[0][0];
  const proj = makeProjection(lon0, lat0);
  const total = rings.reduce((a, r) => a + r.length, 0);
  let tol = 0.5;
  let out = polys;
  for (let count = total; count > 5000; tol *= 2) {
    out = polys.map((p) => p.map((r) => simplifyRing(r, tol, proj)));
    count = out.flat().reduce((a, r) => a + r.length, 0);
  }
  return { polygons: out, usedBBox };
}

function simplifyRing(ring, tol, proj) {
  const xy = ring.map(([lon, lat]) => proj.toXY(lon, lat));
  const keep = new Uint8Array(ring.length);
  const last = ring.length - 1;
  // A closed ring starts and ends on the same point, so split it at the
  // vertex farthest from the start and simplify both halves.
  let far = 1;
  for (let i = 1; i < last; i++) {
    if (Math.hypot(xy[i][0] - xy[0][0], xy[i][1] - xy[0][1]) > Math.hypot(xy[far][0] - xy[0][0], xy[far][1] - xy[0][1])) far = i;
  }
  keep[0] = keep[far] = keep[last] = 1;
  const stack = [[0, far], [far, last]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0;
    let idx = -1;
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * xy[i][0] - dx * xy[i][1] + bx * ay - by * ax) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}
