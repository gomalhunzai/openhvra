// Filling gaps with Overture buildings: the PMTiles index (js/pmtiles.js),
// the vector tile decoder (js/mvt.js) and the duplicate rules
// (js/addbuildings.js). Synthetic data only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { zxyToTileId, parseDirectory, PMTiles } from '../js/pmtiles.js';
import { decodePolygons } from '../js/mvt.js';
import { ringsOverlap, removeOverlaps, toBuildingFeatures, tileRange, fetchCandidates } from '../js/addbuildings.js';
import { near } from './helpers.js';

test('PMTiles tile ids follow the Hilbert curve', () => {
  assert.equal(zxyToTileId(0, 0, 0), 0);
  assert.deepEqual([[0, 0], [0, 1], [1, 1], [1, 0]].map(([x, y]) => zxyToTileId(1, x, y)), [1, 2, 3, 4]);
  assert.equal(zxyToTileId(2, 0, 0), 5);
  assert.equal(zxyToTileId(14, 0, 0), (4 ** 14 - 1) / 3);
});

// ---- Encoders for test data ----------------------------------------------------------------

const varint = (v) => {
  const out = [];
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
const zz = (v) => (v < 0 ? -2 * v - 1 : 2 * v);
const field = (n, type) => varint(n * 8 + type);
const bytesField = (n, b) => [...field(n, 2), ...varint(b.length), ...b];
const str = (s) => [...new TextEncoder().encode(s)];

function encodeDirectory(entries) {
  const out = [...varint(entries.length)];
  let last = 0;
  for (const e of entries) { out.push(...varint(e.tileId - last)); last = e.tileId; }
  for (const e of entries) out.push(...varint(e.runLength));
  for (const e of entries) out.push(...varint(e.length));
  for (const e of entries) out.push(...varint(e.offset + 1));
  return Uint8Array.from(out);
}

test('PMTiles directory round trip', () => {
  const entries = [{ tileId: 3, offset: 0, length: 10, runLength: 1 }, { tileId: 9, offset: 10, length: 250, runLength: 2 }];
  assert.deepEqual(parseDirectory(encodeDirectory(entries)), entries);
});

// One-layer vector tile with square polygons [x0, y0, size] (tile units) and properties.
function encodeTile(layer, squares, extent = 4096) {
  const keys = [];
  const values = [];
  const feats = [];
  for (const { ring: [x0, y0, size], props } of squares) {
    const tags = [];
    for (const [k, v] of Object.entries(props)) {
      if (!keys.includes(k)) keys.push(k);
      values.push(v);
      tags.push(keys.indexOf(k), values.length - 1);
    }
    // Clockwise in tile coordinates (y down) = exterior ring.
    const pts = [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size]];
    const geom = [1 | (1 << 3), zz(pts[0][0]), zz(pts[0][1]), 2 | (3 << 3)];
    for (let i = 1; i < 4; i++) geom.push(zz(pts[i][0] - pts[i - 1][0]), zz(pts[i][1] - pts[i - 1][1]));
    geom.push(7 | (1 << 3));
    const packed = (arr) => arr.flatMap(varint);
    feats.push([...bytesField(2, packed(tags)), ...field(3, 0), 3, ...bytesField(4, packed(geom))]);
  }
  const layerBytes = [...field(15, 0), 2, ...bytesField(1, str(layer)), ...feats.flatMap((f) => bytesField(2, f)),
    ...keys.flatMap((k) => bytesField(3, str(k))), ...values.flatMap((v) => bytesField(4, bytesField(1, str(String(v))))), ...field(5, 0), ...varint(extent)];
  return Uint8Array.from(bytesField(3, layerBytes));
}

test('vector tile polygons decode to longitude/latitude with properties', () => {
  const t = encodeTile('building', [{ ring: [0, 0, 2048], props: { id: 'a', '@geometry_source': 'Google Open Buildings' } }]);
  const [f] = decodePolygons(t, 'building', 1, 1, 0); // north-east quarter of the world
  assert.equal(f.properties.id, 'a');
  assert.equal(f.properties['@geometry_source'], 'Google Open Buildings');
  assert.equal(f.polygons.length, 1);
  const [lon0, lat0] = f.polygons[0][0][0];
  near(lon0, 0);
  near(lat0, 85.0511287798, 1e-6);
  near(f.polygons[0][0][1][0], 90);
  assert.deepEqual(decodePolygons(t, 'other', 1, 1, 0), []);
});

test('candidates come from the tiles over the area, without OSM ones, once per id', async () => {
  // Two neighbouring z14 tiles; building "b" crosses their edge and is in both.
  const z = 14;
  const { x0, y0 } = tileRange([0.001, 0.001, 0.002, 0.002]);
  const tiles = {
    [`${x0}`]: encodeTile('building', [
      { ring: [100, 100, 50], props: { id: 'a', '@geometry_source': 'Microsoft ML Buildings' } },
      { ring: [4000, 100, 96], props: { id: 'b', '@geometry_source': 'Google Open Buildings' } },
      { ring: [300, 300, 50], props: { id: 'c', '@geometry_source': 'OpenStreetMap' } },
    ]),
    [`${x0 + 1}`]: encodeTile('building', [{ ring: [0, 100, 40], props: { id: 'b', '@geometry_source': 'Google Open Buildings' } }]),
  };
  const ids = Object.keys(tiles).map((x) => zxyToTileId(z, +x, y0)).sort((a, b) => a - b);
  const blobs = [];
  let off = 0;
  const entries = ids.map((id) => {
    const x = Object.keys(tiles).find((k) => zxyToTileId(z, +k, y0) === id);
    const g = gzipSync(tiles[x]);
    blobs.push(g);
    const e = { tileId: id, offset: off, length: g.length, runLength: 1 };
    off += g.length;
    return e;
  });
  const root = gzipSync(encodeDirectory(entries));
  const header = new Uint8Array(127);
  header.set(new TextEncoder().encode('PMTiles'), 0);
  header[7] = 3;
  const dv = new DataView(header.buffer);
  dv.setBigUint64(8, 127n, true);
  dv.setBigUint64(16, BigInt(root.length), true);
  dv.setBigUint64(40, BigInt(127 + root.length), true);
  dv.setBigUint64(56, BigInt(127 + root.length), true);
  header[97] = 2; header[98] = 2; header[99] = 1; header[101] = 14;
  const file = Buffer.concat([header, root, ...blobs]);
  const fetchImpl = async (url, { headers }) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    const s = file.subarray(+a, Math.min(file.length, +b + 1));
    return { ok: true, status: 206, arrayBuffer: async () => s.buffer.slice(s.byteOffset, s.byteOffset + s.length) };
  };
  const res = await fetchCandidates([0.001, 0.001, 0.025, 0.002], { release: 'test', fetchImpl });
  const got = Object.fromEntries(res.candidates.map((c) => [c.props.id, c]));
  assert.deepEqual(Object.keys(got).sort(), ['a', 'b']);
  // The larger piece of "b" (96 tile units wide) is kept, not the 40-unit one.
  assert.ok(got.b.area > 2 * 40 * 40 * (2445 / 4096) ** 2);
  const pm = new PMTiles('x', fetchImpl);
  assert.equal(await pm.getTile(z, x0 + 5, y0), null);
});

// ---- Duplicate rules --------------------------------------------------------------------------

const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

test('rings overlap when edges cross or one is inside the other, not when apart', () => {
  assert.equal(ringsOverlap(sq(0, 0, 10), sq(5, 5, 10)), true);
  assert.equal(ringsOverlap(sq(0, 0, 10), sq(2, 2, 3)), true);
  assert.equal(ringsOverlap(sq(2, 2, 3), sq(0, 0, 10)), true);
  assert.equal(ringsOverlap(sq(0, 0, 10), sq(20, 0, 10)), false);
});

// About 11 m per 0.0001° near the equator.
const d = 0.0001;
const llsq = (lon, lat, s) => sq(lon, lat, s);
const cand = (id, lon, lat, s = d) => ({ props: { id, '@geometry_source': 'Microsoft ML Buildings' }, ring: llsq(lon, lat, s), area: 100 });
const osmPoly = (lon, lat, s) => ({ geometry: { type: 'Polygon', coordinates: [llsq(lon, lat, s)] }, properties: {} });
const all = () => true;

test('candidates overlapping an OSM footprint are dropped, others kept', () => {
  const osm = [osmPoly(0, 0, d)];
  const { keep, duplicates } = removeOverlaps([cand('over', 0.00005, 0.00005), cand('free', 0.001, 0.001)], osm, all, [0, 0]);
  assert.deepEqual(keep.map((c) => c.props.id), ['free']);
  assert.equal(duplicates, 1);
});

test('Light mode: the OSM bounding box is used; points get a 5 m radius', () => {
  const box = { geometry: { type: 'Point', coordinates: [0.00005, 0.00005] }, properties: { bbox: [0, 0, d, d] } };
  const pt = { geometry: { type: 'Point', coordinates: [0.01, 0.01] }, properties: {} };
  const cands = [cand('inBox', 0.00008, 0.00008, d / 2), cand('nearPoint', 0.01003, 0.01, d / 2), cand('farFromPoint', 0.0103, 0.01, d / 2)];
  const { keep, duplicates } = removeOverlaps(cands, [box, pt], all, [0, 0]);
  assert.deepEqual(keep.map((c) => c.props.id), ['farFromPoint']);
  assert.equal(duplicates, 2);
});

test('candidates centred outside the area are not added', () => {
  const { keep, outside } = removeOverlaps([cand('in', 0, 0), cand('out', 1, 1)], [], (lon) => lon < 0.5, [0, 0]);
  assert.deepEqual(keep.map((c) => c.props.id), ['in']);
  assert.equal(outside, 1);
});

test('added buildings get OSM-style properties and their source', () => {
  const [a, b] = toBuildingFeatures([
    { props: { id: 'x', '@geometry_source': 'Google Open Buildings' }, ring: llsq(0, 0, d), area: 123.4 },
    { props: { id: 'y', '@geometry_source': 'Microsoft ML Buildings', class: 'house', num_floors: 2 }, ring: llsq(1, 1, d), area: 80 },
  ], 100);
  assert.equal(a.properties.fid, 101);
  assert.equal(a.properties.source, 'Google');
  assert.equal(a.properties.cls, 'unknown');
  assert.equal(a.properties.area, 123);
  assert.equal(a.properties.osm_id, null);
  assert.equal(b.properties.cls, 'residential');
  assert.equal(b.properties.levels, 2);
  near(a.center[0], d / 2);
});
