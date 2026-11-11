// Filling gaps in critical facilities with Overture places (js/addfacilities.js).
// Synthetic data only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { PLACE_GROUPS, fetchPlaces, removeDuplicatePlaces, toFacilityFeatures, MIN_CONFIDENCE } from '../js/addfacilities.js';
import { zxyToTileId } from '../js/pmtiles.js';
import { tileRange } from '../js/addbuildings.js';
import { decodePoints } from '../js/mvt.js';

test('Overture categories map to the critical facility groups only', () => {
  assert.equal(PLACE_GROUPS.hospital, 'health');
  assert.equal(PLACE_GROUPS.pharmacy_and_drug_store, 'health');
  assert.equal(PLACE_GROUPS.elementary_school, 'education');
  assert.equal(PLACE_GROUPS.fire_station, 'emergency');
  assert.equal(PLACE_GROUPS.muslim_place_of_worship, 'community');
  assert.equal(PLACE_GROUPS.gas_station, 'hazardous');
  assert.equal(PLACE_GROUPS.restaurant, undefined);
  assert.equal(PLACE_GROUPS.fashion_and_apparel_store, undefined);
});

// ---- A one-layer point tile and a PMTiles file around it --------------------------------------

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
const dbl = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return [...field(3, 1), ...b];
};

function pointTile(points) {
  const keys = [];
  const values = [];
  const feats = points.map(({ at: [px, py], props }) => {
    const tags = [];
    for (const [k, v] of Object.entries(props)) {
      if (!keys.includes(k)) keys.push(k);
      values.push(typeof v === 'number' ? dbl(v) : bytesField(1, str(v)));
      tags.push(keys.indexOf(k), values.length - 1);
    }
    const geom = [1 | (1 << 3), zz(px), zz(py)];
    const packed = (a) => a.flatMap(varint);
    return [...bytesField(2, packed(tags)), ...field(3, 0), 1, ...bytesField(4, packed(geom))];
  });
  const layer = [...field(15, 0), 2, ...bytesField(1, str('place')), ...feats.flatMap((f) => bytesField(2, f)),
    ...keys.flatMap((k) => bytesField(3, str(k))), ...values.flatMap((v) => bytesField(4, v)), ...field(5, 0), ...varint(4096)];
  return Uint8Array.from(bytesField(3, layer));
}

function pmtilesWith(tileId, tile) {
  const g = gzipSync(tile);
  const dir = gzipSync(Uint8Array.from([...varint(1), ...varint(tileId), ...varint(1), ...varint(g.length), ...varint(1)]));
  const header = new Uint8Array(127);
  header.set(new TextEncoder().encode('PMTiles'), 0);
  header[7] = 3;
  const dv = new DataView(header.buffer);
  dv.setBigUint64(8, 127n, true);
  dv.setBigUint64(16, BigInt(dir.length), true);
  dv.setBigUint64(40, BigInt(127 + dir.length), true);
  dv.setBigUint64(56, BigInt(127 + dir.length), true);
  header[97] = 2; header[98] = 2; header[99] = 1; header[101] = 14;
  const file = Buffer.concat([header, dir, g]);
  return async (url, { headers }) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    const s = file.subarray(+a, Math.min(file.length, +b + 1));
    return { ok: true, status: 206, arrayBuffer: async () => s.buffer.slice(s.byteOffset, s.byteOffset + s.length) };
  };
}

test('points decode, and only open, confident, critical places are kept', async () => {
  const bbox = [0.001, 0.001, 0.002, 0.002];
  const { x0, y0 } = tileRange(bbox);
  const tile = pointTile([
    { at: [100, 100], props: { id: 'h', basic_category: 'hospital', confidence: 0.9, operating_status: 'open', '@name': 'City Hospital', sources: '[{"dataset":"meta"}]' } },
    { at: [200, 100], props: { id: 'low', basic_category: 'elementary_school', confidence: MIN_CONFIDENCE - 0.01 } },
    { at: [300, 100], props: { id: 'shut', basic_category: 'clinic_x', confidence: 0.9 } },
    { at: [400, 100], props: { id: 'closed', basic_category: 'police_station', confidence: 0.9, operating_status: 'permanently_closed' } },
    { at: [500, 100], props: { id: 'cafe', basic_category: 'cafe', confidence: 0.99 } },
  ]);
  const [p] = decodePoints(tile, 'place', 14, x0, y0);
  assert.equal(p.properties.basic_category, 'hospital');
  assert.equal(p.properties.confidence, 0.9);
  const res = await fetchPlaces(bbox, { release: 't', fetchImpl: pmtilesWith(zxyToTileId(14, x0, y0), tile) });
  assert.deepEqual(res.places.map((q) => q.id), ['h']);
  assert.equal(res.places[0].name, 'City Hospital');
  assert.equal(res.places[0].datasets, 'meta');
  assert.deepEqual(res.skipped, { lowConfidence: 1, closed: 1 });
});

// ~11 m per 0.0001° near the equator.
const place = (id, group, lon, name = '') => ({ id, group, category: 'x', name, lonlat: [lon, 0], confidence: 0.8, datasets: '' });
const osm = (group, lon, name = '') => ({ center: [lon, 0], properties: { group, name } });
const all = () => true;

test('a place near an OSM facility of the same group, or with the same name, is a duplicate', () => {
  const osmF = [osm('health', 0, 'St Mary'), osm('education', 0.01)];
  const { keep, duplicates } = removeDuplicatePlaces([
    place('sameGroupNear', 'health', 0.0005), // ~55 m, same group
    place('sameNameNear', 'community', 0.0008, 'St. Mary'), // ~90 m, same name after normalising
    place('otherGroupNear', 'emergency', 0.0003), // ~33 m, other group, no name
    place('sameGroupFar', 'health', 0.002), // ~220 m
  ], osmF, all, [0, 0]);
  assert.deepEqual(keep.map((k) => k.id), ['otherGroupNear', 'sameGroupFar']);
  assert.equal(duplicates, 2);
});

test('two Overture places count once only if they share a name', () => {
  const { keep } = removeDuplicatePlaces([
    place('a', 'health', 0.05, 'Clinic A'), place('a2', 'health', 0.0501, 'Clinic A'), place('b', 'health', 0.0502, 'Clinic B'),
  ], [], all, [0, 0]);
  assert.deepEqual(keep.map((k) => k.id), ['a', 'b']);
});

test('places outside the area are not added; features look like OSM ones', () => {
  const { keep, outside } = removeDuplicatePlaces([place('in', 'health', 0), place('out', 'health', 1)], [], (lon) => lon < 0.5, [0, 0]);
  assert.equal(outside, 1);
  const [f] = toFacilityFeatures(keep, 41);
  assert.equal(f.properties.fid, 42);
  assert.equal(f.properties.kind, 'facility');
  assert.equal(f.properties.group, 'health');
  assert.equal(f.properties.osm_id, null);
  assert.equal(f.properties.source, 'Overture places');
});
