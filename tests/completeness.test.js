// OSM building completeness (js/completeness.js) and the GHSL reader
// (js/ghsl.js). The reader is tested on a small synthetic tiled GeoTIFF
// served by a fake fetch, so no network is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { parseGhslHeader, loadBuiltUp, undoPredictor16 } from '../js/ghsl.js';
import { computeCompleteness, completenessClass, completenessRating, completenessGeoJSON } from '../js/completeness.js';
import { near } from './helpers.js';

// A W × H uint16 GeoTIFF in T × T deflate blocks, cell size d degrees,
// north-west corner (west, north); value(c, r) gives each cell.
function makeTiff({ W, H, T, d, west, north, value }) {
  const across = Math.ceil(W / T);
  const down = Math.ceil(H / T);
  const blocks = [];
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      const v = new Uint16Array(T * T);
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
        const c = bx * T + x;
        const r = by * T + y;
        v[y * T + x] = c < W && r < H ? value(c, r) : 0;
      }
      // An all-zero block is stored as empty (byte count 0), as in the real file.
      blocks.push(v.some((x) => x) ? deflateSync(Buffer.from(v.buffer)) : Buffer.alloc(0));
    }
  }
  const tags = [
    [256, 4, 1, W], [257, 4, 1, H], [258, 3, 1, 16], [259, 3, 1, 8], [317, 3, 1, 1],
    [322, 3, 1, T], [323, 3, 1, T], [324, 4, blocks.length, 'offsets'], [325, 4, blocks.length, 'counts'],
    [33550, 12, 3, 'scale'], [33922, 12, 6, 'tie'],
  ];
  const ifdAt = 8;
  let p = ifdAt + 2 + tags.length * 12 + 4;
  const at = {};
  at.offsets = p; p += 4 * blocks.length;
  at.counts = p; p += 4 * blocks.length;
  at.scale = p; p += 24;
  at.tie = p; p += 48;
  const dataAt = p;
  const total = dataAt + blocks.reduce((a, b) => a + b.length, 0);
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0x4949);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdAt, true);
  dv.setUint16(ifdAt, tags.length, true);
  tags.forEach(([tag, type, n, v], i) => {
    const e = ifdAt + 2 + i * 12;
    dv.setUint16(e, tag, true);
    dv.setUint16(e + 2, type, true);
    dv.setUint32(e + 4, n, true);
    if (typeof v === 'string') dv.setUint32(e + 8, at[v], true);
    else if (type === 3) dv.setUint16(e + 8, v, true);
    else dv.setUint32(e + 8, v, true);
  });
  let off = dataAt;
  blocks.forEach((b, i) => {
    dv.setUint32(at.offsets + 4 * i, b.length ? off : 0, true);
    dv.setUint32(at.counts + 4 * i, b.length, true);
    buf.set(b, off);
    off += b.length;
  });
  [d, d, 0].forEach((v, i) => dv.setFloat64(at.scale + 8 * i, v, true));
  [0, 0, 0, west, north, 0].forEach((v, i) => dv.setFloat64(at.tie + 8 * i, v, true));
  return buf;
}

function fakeFetch(buf) {
  const calls = [];
  const impl = async (url, { headers }) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    calls.push([+a, +b]);
    const slice = buf.slice(+a, Math.min(buf.length, +b + 1));
    return { ok: true, status: 206, arrayBuffer: async () => slice.buffer };
  };
  return { impl, calls };
}

const spec = { W: 10, H: 10, T: 4, d: 0.01, west: 10, north: 50, value: (c, r) => 100 * r + c };

test('GHSL header gives the grid and where the block index is', () => {
  const H = parseGhslHeader(makeTiff(spec));
  assert.equal(H.w, 10);
  assert.equal(H.tw, 4);
  assert.equal(H.compressed, true);
  near(H.west, 10);
  near(H.north, 50);
  near(H.dx, 0.01);
});

test('reads only the window of the area, across block edges', async () => {
  const buf = makeTiff(spec);
  const { impl, calls } = fakeFetch(buf);
  // Columns 3–5 and rows 2–6: crosses block boundaries in both directions.
  const g = await loadBuiltUp([10.035, 49.935, 10.055, 49.975], { url: 'test://a', fetchImpl: impl });
  assert.equal(g.w, 3);
  assert.equal(g.h, 5);
  near(g.west, 10.03);
  near(g.north, 49.98);
  for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) assert.equal(g.data[r * g.w + c], 100 * (r + 2) + (c + 3));
  // After the 4 kB header: small slices of the block index and the blocks.
  assert.equal(calls[0][0], 0);
  assert.ok(calls.slice(1).every(([a, b]) => b - a < 200), 'small range requests only');
});

test('empty blocks read as zero built-up area', async () => {
  const buf = makeTiff({ ...spec, value: (c, r) => (c >= 4 ? 7 : 0) });
  const { impl } = fakeFetch(buf);
  const g = await loadBuiltUp([10.005, 49.905, 10.095, 49.995], { url: 'test://b', fetchImpl: impl });
  assert.equal(g.data[0], 0);
  assert.equal(g.data[g.w - 1], 7);
});

test('horizontal predictor for 16-bit samples', () => {
  const v = Uint16Array.from([5, 1, 1, 65535, 2, 3]);
  assert.deepEqual([...undoPredictor16(v, 3, 2)], [5, 6, 7, 65535, 1, 4]);
});

test('classes and overall rating', () => {
  assert.equal(completenessClass(0.1), 0);
  assert.equal(completenessClass(0.25), 1);
  assert.equal(completenessClass(0.79), 2);
  assert.equal(completenessClass(1.4), 3);
  assert.equal(completenessRating(0.85).key, 'good');
  assert.equal(completenessRating(0.6).key, 'partial');
  assert.equal(completenessRating(0.3).key, 'low');
});

// A 6 × 3 grid of 0.001° cells: two 3 × 3 blocks with 900 m² per cell.
const grid = { west: 0, north: 0.003, dx: 0.001, dy: 0.001, w: 6, h: 3, data: new Uint16Array(18).fill(900) };
const all = () => true;

test('ratio of OSM footprint area to GHSL built-up area, per block and overall', () => {
  // Left block fully mapped (8100 m²), right block a quarter mapped (2025 m²).
  const buildings = [
    { lon: 0.0015, lat: 0.0015, area: 8100 },
    { lon: 0.0045, lat: 0.0015, area: 2025 },
  ];
  const res = computeCompleteness(grid, buildings, all);
  assert.equal(res.blocks.length, 2);
  near(res.blocks[0].ratio, 1);
  near(res.blocks[1].ratio, 0.25);
  assert.equal(res.blocks[1].cls, 1);
  near(res.ratio, 10125 / 16200);
  assert.equal(res.rating.key, 'partial');
  near(res.missing, 8100 - 2025);
  near(res.lowShare, 0.5);
  assert.deepEqual(res.classCounts, [0, 1, 0, 1]);
});

test('only cells inside the area count as reference', () => {
  // Area = left half only: the right block has no reference and no OSM.
  const left = (lon) => lon < 0.003;
  const res = computeCompleteness(grid, [{ lon: 0.0015, lat: 0.0015, area: 4050 }], left);
  assert.equal(res.blocks.length, 1);
  near(res.refTotal, 8100);
  near(res.ratio, 0.5);
});

test('blocks with little built-up area are not classed but still count overall', () => {
  const sparse = { ...grid, data: new Uint16Array(18).fill(10) }; // 90 m² per block
  const res = computeCompleteness(sparse, [{ lon: 0.0015, lat: 0.0015, area: 90 }], all);
  assert.equal(res.blocks.length, 0);
  near(res.ratio, 90 / 180);
});

test('no built-up area gives no ratio', () => {
  const empty = { ...grid, data: new Uint16Array(18) };
  const res = computeCompleteness(empty, [], all);
  assert.equal(res.ratio, null);
  assert.equal(res.rating, null);
});

test('map layer has one polygon per classed block', () => {
  const res = computeCompleteness(grid, [{ lon: 0.0015, lat: 0.0015, area: 8100 }], all);
  const gj = completenessGeoJSON(res);
  assert.equal(gj.features.length, 2);
  assert.deepEqual(gj.features[1].properties, { cls: 0, pct: 0, ref_m2: 8100, osm_m2: 0 });
  assert.deepEqual(gj.features[0].geometry.coordinates[0][0], [0, 0]);
});
