// Copernicus DEM reader (js/copdem.js), the shared elevation grid and the
// source switch with fallback (js/elevation.js). Uses small synthetic
// GeoTIFFs served by a fake fetch, so no network is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { tileName, parseHeader, decodeFloatPredictor, loadCopDEM } from '../js/copdem.js';
import { GridDEM, DEM } from '../js/risk.js';
import { loadElevation } from '../js/elevation.js';
import { near } from './helpers.js';

test('tile names follow the south-west corner', () => {
  assert.equal(tileName(53, -3), 'Copernicus_DSM_COG_10_N53_00_W003_00_DEM');
  assert.equal(tileName(-1, 36), 'Copernicus_DSM_COG_10_S01_00_E036_00_DEM');
  assert.equal(tileName(0, 0), 'Copernicus_DSM_COG_10_N00_00_E000_00_DEM');
});

// Inverse of TIFF predictor 3, to build test data.
function encodeFloatPredictor(values, tw, th) {
  const u32 = new Uint32Array(Float32Array.from(values).buffer);
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const b = y * tw * 4;
    for (let x = 0; x < tw; x++) {
      const v = u32[y * tw + x];
      out[b + x] = v >>> 24;
      out[b + tw + x] = (v >>> 16) & 255;
      out[b + 2 * tw + x] = (v >>> 8) & 255;
      out[b + 3 * tw + x] = v & 255;
    }
    for (let i = tw * 4 - 1; i > 0; i--) out[b + i] = (out[b + i] - out[b + i - 1]) & 255;
  }
  return out;
}

test('floating-point predictor round trip', () => {
  const vals = [0, 1.5, -12.25, 8848.86, 3.4e38, -0.001, 100, 7];
  const dec = decodeFloatPredictor(encodeFloatPredictor(vals, 4, 2), 4, 2);
  for (let i = 0; i < vals.length; i++) assert.equal(dec[i], Math.fround(vals[i]));
});

// A one-level tiled GeoTIFF of n × n point samples per degree, as one block,
// with the values of f(lon, lat) at the pixel centres. Like Copernicus: the
// first pixel centre is exactly on the north-west whole degree.
function syntheticTiff(lat, lon, n, f) {
  const vals = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) vals.push(f(lon + c / n, lat + 1 - r / n));
  const block = deflateSync(encodeFloatPredictor(vals, n, n));
  const entries = [
    [256, 3, [n]], [257, 3, [n]], [258, 3, [32]], [259, 3, [8]], [317, 3, [3]],
    [322, 3, [n]], [323, 3, [n]], [324, 4, [0]], [325, 4, [block.length]], [339, 3, [3]],
    [33550, 12, [1 / n, 1 / n, 0]], [33922, 12, [0, 0, 0, lon, lat + 1, 0]],
    [34735, 3, [1, 1, 0, 2, 1024, 0, 1, 2, 1025, 0, 1, 2]],
  ];
  const size = { 3: 2, 4: 4, 12: 8 };
  const ifdLen = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdLen;
  const extras = [];
  for (const [, type, v] of entries) {
    const bytes = size[type] * v.length;
    if (bytes > 4) { extras.push(extra); extra += bytes; } else extras.push(null);
  }
  const dataStart = extra;
  const buf = new Uint8Array(dataStart + block.length);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0x4949);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, v], i) => {
    const e = 10 + i * 12;
    dv.setUint16(e, tag, true);
    dv.setUint16(e + 2, type, true);
    dv.setUint32(e + 4, v.length, true);
    const at = extras[i] ?? e + 8;
    if (extras[i] != null) dv.setUint32(e + 8, extras[i], true);
    v.forEach((x, k) => {
      if (tag === 324) x = dataStart;
      if (type === 3) dv.setUint16(at + 2 * k, x, true);
      else if (type === 4) dv.setUint32(at + 4 * k, x, true);
      else dv.setFloat64(at + 8 * k, x, true);
    });
  });
  buf.set(block, dataStart);
  return buf;
}

test('header: point samples give a half-pixel corner offset', () => {
  const { levels } = parseHeader(syntheticTiff(10, 20, 8, () => 0));
  const L = levels[0];
  assert.equal(L.w, 8);
  near(L.dx, 1 / 8);
  near(L.west, 20 - 1 / 16);
  near(L.north, 11 + 1 / 16);
  assert.equal(L.predictor, 3);
});

// Fake Planetary Computer: a token endpoint and range reads of synthetic files.
function fakeFetch(files, log = []) {
  return async (url, opts = {}) => {
    log.push(String(url));
    if (String(url).includes('/api/sas/')) {
      return new Response(JSON.stringify({ token: 'sig=test', 'msft:expiry': '2999-01-01T00:00:00Z' }));
    }
    const name = String(url).match(/COP30_hh\/(.+)\.tif/)?.[1];
    const file = name && files[name];
    if (!file) return new Response('missing', { status: 404 });
    const [a, b] = opts.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    return new Response(file.slice(a, Math.min(b + 1, file.length)), { status: 206 });
  };
}

test('area across two files matches a linear surface exactly', async () => {
  const f = (lon, lat) => 100 + 50 * lon + 20 * lat;
  const files = {
    [tileName(10, 20)]: syntheticTiff(10, 20, 64, f),
    [tileName(10, 21)]: syntheticTiff(10, 21, 64, f),
  };
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch(files);
  try {
    const dem = await loadCopDEM([20.9, 10.4, 21.1, 10.6]);
    assert.equal(dem.source, 'copernicus');
    assert.equal(dem.files.length, 2);
    for (const [lon, lat] of [[20.95, 10.5], [20.999, 10.45], [21.0, 10.5], [21.004, 10.55], [21.08, 10.42]]) {
      near(dem.elev(lon, lat), f(lon, lat), 1e-2, `at ${lon},${lat}`);
    }
    // Pixels are square on the ground at about the native spacing (1/64° here).
    near(dem.resolutionM, Math.round(Math.min(Math.cos((10.5 * Math.PI) / 180), 1) * 111319.49 / 64), 1);
  } finally {
    globalThis.fetch = saved;
  }
});

test('a missing neighbour file leaves gaps (NaN) instead of wrong heights', async () => {
  // (A different place from the test above: files are cached by name.)
  const files = { [tileName(30, 40)]: syntheticTiff(30, 40, 32, () => 5) };
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch(files);
  try {
    const dem = await loadCopDEM([40.9, 30.4, 41.1, 30.6]);
    near(dem.elev(40.95, 30.5), 5);
    assert.ok(Number.isNaN(dem.elev(41.05, 30.5)));
  } finally {
    globalThis.fetch = saved;
  }
});

test('no file at all is an error (so the fallback can take over)', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch({});
  try {
    await assert.rejects(loadCopDEM([-30.5, 40.1, -30.4, 40.2]), /no Copernicus GLO-30 data/);
  } finally {
    globalThis.fetch = saved;
  }
});

test('fallback: Terrain Tiles are tried when Copernicus fails', async () => {
  const saved = globalThis.fetch;
  const log = [];
  globalThis.fetch = fakeFetch({}, log);
  try {
    // The fake serves no Terrain Tiles either, so the fallback itself fails;
    // what matters is that it was attempted.
    await assert.rejects(loadElevation([-30.5, 40.1, -30.4, 40.2]), /elevation tiles could not be downloaded/);
    assert.ok(log.some((u) => u.includes('elevation-tiles-prod/terrarium')));
  } finally {
    globalThis.fetch = saved;
  }
});

test('grid: pixel and lonLat are inverses', () => {
  const dem = new GridDEM({ z: 14.37, ox: 1000, oy: 2000, w: 10, h: 10, data: new Float32Array(100) });
  const [lon, lat] = dem.lonLat(3.25, 7.5);
  const [px, py] = dem.pixel(lon, lat);
  near(px, 3.25, 1e-6);
  near(py, 7.5, 1e-6);
});

test('grid: channel search radius depends on the source', () => {
  const data = new Float32Array(25).fill(10);
  data[0] = 1; // two pixels from the centre
  const cop = new GridDEM({ z: 14, ox: 0, oy: 0, w: 5, h: 5, data, channelRadius: 1 });
  const [lon, lat] = cop.lonLat(2, 2);
  assert.equal(cop.minAround(lon, lat), 10);
  assert.equal(cop.minAround(lon, lat, 2), 1);
  assert.equal(cop.maxElev(), 10);
  const tile = Float32Array.from({ length: 65536 }, (_, i) => i % 256);
  const terrain = new DEM(14, 5, 5, 1, 1, [tile]);
  assert.equal(terrain.channelRadius, 2);
  assert.equal(terrain._at(7, 3), 7);
  assert.equal(terrain.source, 'terrain');
});
