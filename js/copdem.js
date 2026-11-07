// Copernicus DEM GLO-30, read straight from its Cloud Optimized GeoTIFFs.
//
// The 1° × 1° files are hosted by Microsoft Planetary Computer, which allows
// browser access with a free anonymous token. Only the 1024 × 1024 blocks
// that cover the area are downloaded (HTTP range requests), unzipped with the
// browser's own DecompressionStream and resampled onto a square Web Mercator
// grid at about the native spacing, so the analyses can use them like the
// Terrain Tiles. No library is needed.
//
// Heights are metres above the EGM2008 geoid. GLO-30 is a surface model:
// rooftops and tree canopy are included, as in SRTM.

import { GridDEM, lonToPx, latToPx } from './risk.js';

const ACCOUNT = 'https://elevationeuwest.blob.core.windows.net/copernicus-dem';
const TOKEN_URL = 'https://planetarycomputer.microsoft.com/api/sas/v1/token/elevationeuwest/copernicus-dem';
const M_PER_DEG = 40075016.686 / 360;
const NODATA_BELOW = -1000;

export const COPDEM_CREDIT = 'Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; all rights reserved';

// File name of the 1° tile whose south-west corner is (lat, lon), both integers.
export function tileName(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `Copernicus_DSM_COG_10_${ns}${String(Math.abs(lat)).padStart(2, '0')}_00_${ew}${String(Math.abs(lon)).padStart(3, '0')}_00_DEM`;
}

// ---- Access token ----------------------------------------------------------------------------

let token = null; // { value, expires (ms) }

async function getToken(signal, refresh = false) {
  if (!refresh && token && token.expires - Date.now() > 5 * 60e3) return token.value;
  const res = await fetch(TOKEN_URL, { signal });
  if (!res.ok) throw new Error(`Planetary Computer token request failed (HTTP ${res.status})`);
  const j = await res.json();
  token = { value: j.token, expires: Date.parse(j['msft:expiry']) || Date.now() + 30 * 60e3 };
  return token.value;
}

// Range request, retried once with a fresh token if the old one was refused.
// Returns null if the file does not exist (open sea, or outside the release).
async function fetchRange(name, start, end, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getToken(signal, attempt > 0);
    const res = await fetch(`${ACCOUNT}/COP30_hh/${name}.tif?${t}`, { signal, headers: { Range: `bytes=${start}-${end}` } });
    if (res.status === 404) return null;
    if (res.status === 403 && attempt === 0) continue;
    if (!res.ok) throw new Error(`Copernicus DEM download failed (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
  throw new Error('Copernicus DEM access was refused');
}

// ---- TIFF header -----------------------------------------------------------------------------

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8, 16: 8 };

// Parses a classic little-endian TIFF header from the first bytes of a file.
// Returns { levels: [...] } or { need: byteCount } if the header is longer.
export function parseHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0) !== 0x4949) throw new Error('unsupported TIFF byte order');
  if (dv.getUint16(2, true) !== 42) throw new Error('unsupported TIFF variant');
  const ifds = [];
  let off = dv.getUint32(4, true);
  let need = 0;
  while (off) {
    if (off + 2 > bytes.length) return { need: off + 4096 };
    const count = dv.getUint16(off, true);
    if (off + 2 + count * 12 + 4 > bytes.length) return { need: off + 2 + count * 12 + 4096 };
    const tags = {};
    for (let i = 0; i < count; i++) {
      const e = off + 2 + i * 12;
      const tag = dv.getUint16(e, true);
      const type = dv.getUint16(e + 2, true);
      const n = dv.getUint32(e + 4, true);
      const size = (TYPE_SIZE[type] ?? 1) * n;
      const p = size <= 4 ? e + 8 : dv.getUint32(e + 8, true);
      if (p + size > bytes.length) {
        need = Math.max(need, p + size);
        continue;
      }
      const v = [];
      for (let k = 0; k < n && type !== 2; k++) {
        if (type === 3) v.push(dv.getUint16(p + 2 * k, true));
        else if (type === 4) v.push(dv.getUint32(p + 4 * k, true));
        else if (type === 12) v.push(dv.getFloat64(p + 8 * k, true));
        else if (type === 1) v.push(dv.getUint8(p + k));
      }
      tags[tag] = v;
    }
    ifds.push(tags);
    off = dv.getUint32(off + 2 + count * 12, true);
  }
  if (need) return { need };
  const base = ifds[0];
  const [sx, sy] = base[33550];
  const [I, J, , X, Y] = base[33922];
  // GeoKey 1025 (raster type): 2 = values are point samples at pixel centres.
  const keys = base[34735] ?? [];
  let pointSamples = false;
  for (let i = 4; i + 3 < keys.length; i += 4) if (keys[i] === 1025) pointSamples = keys[i + 3] === 2;
  const west = X - I * sx - (pointSamples ? sx / 2 : 0);
  const north = Y + J * sy + (pointSamples ? sy / 2 : 0);
  const extentX = base[256][0] * sx;
  const extentY = base[257][0] * sy;
  const levels = ifds
    .filter((t) => t[322] && t[324])
    .map((t) => {
      if (t[259]?.[0] !== 8 && t[259]?.[0] !== 1) throw new Error('unsupported TIFF compression');
      if (t[339]?.[0] !== 3 || t[258]?.[0] !== 32) throw new Error('unsupported TIFF sample format');
      const w = t[256][0];
      const h = t[257][0];
      return {
        w, h, tw: t[322][0], th: t[323][0], offsets: t[324], counts: t[325],
        compressed: t[259][0] === 8, predictor: t[317]?.[0] ?? 1,
        west, north, dx: extentX / w, dy: extentY / h,
      };
    });
  return { levels };
}

// ---- Block decoding --------------------------------------------------------------------------

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Undoes TIFF predictor 3 (floating point): byte differencing along each row,
// with the bytes of each value split into planes, most significant first.
export function decodeFloatPredictor(bytes, tw, th) {
  const out = new Float32Array(tw * th);
  const u32 = new Uint32Array(out.buffer);
  const rowBytes = tw * 4;
  for (let y = 0; y < th; y++) {
    const b = y * rowBytes;
    for (let i = 1; i < rowBytes; i++) bytes[b + i] = (bytes[b + i] + bytes[b + i - 1]) & 255;
    for (let x = 0; x < tw; x++) {
      u32[y * tw + x] = ((bytes[b + x] << 24) | (bytes[b + tw + x] << 16) | (bytes[b + 2 * tw + x] << 8) | bytes[b + 3 * tw + x]) >>> 0;
    }
  }
  return out;
}

async function decodeBlock(bytes, L) {
  const raw = L.compressed ? await inflate(bytes) : bytes;
  if (raw.length < L.tw * L.th * 4) throw new Error('truncated elevation block');
  if (L.predictor === 3) return decodeFloatPredictor(raw, L.tw, L.th);
  if (L.predictor === 1) return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + L.tw * L.th * 4));
  throw new Error('unsupported TIFF predictor');
}

// ---- Caches (shared by the area, the GLOF region and lake look-ups) -------------------------

const headers = new Map(); // name → Promise<levels | null>
const blocks = new Map(); // `${name}/${level}/${index}` → Promise<Float32Array | null>
const MAX_BLOCKS = 20; // each decoded block is 4 MB

function header(name, signal) {
  if (!headers.has(name)) {
    const p = (async () => {
      let len = 65536;
      for (let i = 0; i < 4; i++) {
        const bytes = await fetchRange(name, 0, len - 1, signal);
        if (!bytes) return null;
        const h = parseHeader(bytes);
        if (h.levels) return h.levels;
        len = h.need;
      }
      throw new Error('elevation file header too large');
    })();
    headers.set(name, p);
    p.catch(() => headers.delete(name));
  }
  return headers.get(name);
}

function block(name, L, level, index, signal) {
  const key = `${name}/${level}/${index}`;
  if (blocks.has(key)) {
    const p = blocks.get(key);
    blocks.delete(key); // refresh its place in the eviction order
    blocks.set(key, p);
    return p;
  }
  const p = (async () => {
    const off = L.offsets[index];
    const n = L.counts[index];
    if (!n) return null;
    const bytes = await fetchRange(name, off, off + n - 1, signal);
    return bytes ? decodeBlock(bytes, L) : null;
  })();
  blocks.set(key, p);
  p.catch(() => blocks.delete(key));
  while (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value);
  return p;
}

// ---- Loading an area -------------------------------------------------------------------------

// Loads elevation for bbox [w, s, e, n] onto a Mercator grid. Uses the finest
// overview level (from minLevel) whose grid has at most maxPixels cells.
export async function loadCopDEM([w, s, e, n], { signal, onProgress, maxPixels = 4e6, minLevel = 0 } = {}) {
  // 1. Headers of every 1° file touching the area (plus a pixel of margin).
  const files = new Map(); // `${lat},${lon}` → { name, levels }
  const jobs = [];
  for (let lat = Math.floor(s - 0.001); lat <= Math.floor(n + 0.001); lat++) {
    for (let lon = Math.floor(w - 0.001); lon <= Math.floor(e + 0.001); lon++) {
      const name = tileName(lat, lon);
      jobs.push(header(name, signal).then((levels) => levels && files.set(`${lat},${lon}`, { name, levels })));
    }
  }
  await Promise.all(jobs);
  if (!files.size) throw new Error('no Copernicus GLO-30 data for this area');

  // Width (columns per degree) of each 1° row of files: it shrinks towards the poles.
  const any = files.values().next().value.levels;
  const nLevels = Math.min(...[...files.values()].map((f) => f.levels.length));
  const rowLevels = new Map(); // lat → levels of any file in that row
  for (const [k, f] of files) rowLevels.set(+k.split(',')[0], f.levels);

  // 2. Grid resolution: the native spacing at the area's middle latitude.
  const midLat = (s + n) / 2;
  const cos = Math.cos((midLat * Math.PI) / 180);
  const midRow = rowLevels.get(Math.floor(midLat)) ?? any;
  let level = Math.min(minLevel, nLevels - 1);
  let z, ox, oy, gw, gh, spacing;
  for (; level < nLevels; level++) {
    const L = midRow[level];
    spacing = Math.min(L.dx * M_PER_DEG * cos, L.dy * M_PER_DEG);
    z = Math.log2((40075016.686 * cos) / (256 * spacing));
    ox = Math.floor(lonToPx(w, z));
    oy = Math.floor(latToPx(n, z));
    gw = Math.ceil(lonToPx(e, z)) - ox + 1;
    gh = Math.ceil(latToPx(s, z)) - oy + 1;
    if (gw * gh <= maxPixels || level === nLevels - 1) break;
  }

  // 3. Source addressing: global row index g (uniform), then columns per file row.
  const L0 = any[level];
  const top0 = 90 + (L0.north - Math.round(L0.north)); // files start half a pixel north of their whole degree
  const R = L0.h; // rows per 1° file
  const lons = new Float64Array(gw);
  const lats = new Float64Array(gh);
  const N = 256 * 2 ** z;
  for (let i = 0; i < gw; i++) lons[i] = ((ox + i + 0.5) / N) * 360 - 180;
  for (let j = 0; j < gh; j++) lats[j] = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (oy + j + 0.5)) / N))) * 180) / Math.PI;

  const needed = new Map(); // block key → { name, L, index }
  const loaded = new Map(); // block key → Float32Array | null
  // Value (or, in the first pass, the block needed) at global row gi, column c of that row.
  const cell = (fileLat, levels, r, c, collect) => {
    const L = levels[level];
    const C = L.w;
    const j = Math.floor(c / C);
    const ci = c - j * C;
    const f = files.get(`${fileLat},${j - 180}`);
    if (!f) return NaN;
    const FL = f.levels[level];
    const bx = Math.floor(ci / FL.tw);
    const by = Math.floor(r / FL.th);
    const index = by * Math.ceil(FL.w / FL.tw) + bx;
    const key = `${f.name}/${level}/${index}`;
    if (collect) {
      if (!needed.has(key)) needed.set(key, { name: f.name, L: FL, index });
      return 0;
    }
    const data = loaded.get(key);
    if (!data) return NaN;
    const v = data[(r - by * FL.th) * FL.tw + (ci - bx * FL.tw)];
    return v > NODATA_BELOW ? v : NaN;
  };
  const rowValue = (gi, lon, collect) => {
    const k = Math.floor(gi / R);
    const fileLat = 89 - k;
    const levels = rowLevels.get(fileLat);
    if (!levels) return NaN;
    const r = gi - k * R;
    const L = levels[level];
    // Files start half a full-resolution pixel west of their whole degree.
    const cg = (lon + 180 - (L.west - Math.round(L.west))) / L.dx - 0.5;
    const c0 = Math.floor(cg);
    const fx = cg - c0;
    const a = cell(fileLat, levels, r, c0, collect);
    const b = cell(fileLat, levels, r, c0 + 1, collect);
    return a * (1 - fx) + b * fx;
  };
  const value = (lon, lat, collect) => {
    const g = (top0 - lat) / L0.dy - 0.5;
    const g0 = Math.floor(g);
    const fy = g - g0;
    const a = rowValue(g0, lon, collect);
    const b = rowValue(g0 + 1, lon, collect);
    return a * (1 - fy) + b * fy;
  };

  // 4. Collect and download the blocks, then fill the grid.
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) value(lons[i], lats[j], true);
  let done = 0;
  await Promise.all([...needed].map(async ([key, b]) => {
    loaded.set(key, await block(b.name, b.L, level, b.index, signal));
    onProgress?.(++done, needed.size);
  }));
  if ([...loaded.values()].every((v) => !v)) throw new Error('no Copernicus GLO-30 data for this area');
  const data = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) data[j * gw + i] = value(lons[i], lats[j], false);

  return new GridDEM({
    z, ox, oy, w: gw, h: gh, data,
    source: 'copernicus',
    label: `Copernicus GLO-30, ${Math.round(spacing)} m grid${level ? ` (overview level ${level})` : ''}`,
    resolutionM: Math.round(spacing),
    files: [...files.values()].map((f) => f.name),
    channelRadius: 1,
    slopeStep: 1,
  });
}
