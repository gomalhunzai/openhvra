// GHSL built-up surface (GHS-BUILT-S R2023A, epoch 2020, 3 arc-seconds),
// read straight from the European Commission's Cloud Optimized GeoTIFF on
// the AWS Open Data registry. The file is one global grid of 432,002 ×
// 213,822 cells; only the 512 × 512 blocks covering the area are downloaded
// (HTTP range requests), together with the matching slices of the block
// index, so a typical town costs a few hundred kB. No library is needed.
//
// Each cell holds the built-up surface in m² (roofed area of buildings) in
// that ~90 m cell. Used as an independent reference to estimate how complete
// the OSM buildings are (see completeness.js).

export const GHSL_URL = 'https://jrc-ghsl.s3.amazonaws.com/ghs-built-s/r2023a/4326/3asec/2020/GHS_BUILT_S_E2020_GLOBE_R2023A_4326_3ss_V1_0.tif';
export const GHSL_LABEL = 'GHSL built-up surface 2020 (GHS-BUILT-S R2023A, 3 arc-seconds)';
export const GHSL_CREDIT = 'GHS-BUILT-S R2023A © European Union, Joint Research Centre (Pesaresi & Politis 2023), CC BY 4.0';

async function fetchRange(url, start, end, signal, fetchImpl = fetch) {
  const res = await fetchImpl(url, { signal, headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok) throw new Error(`GHSL download failed (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

// Parses the first image directory of a classic little-endian tiled TIFF.
// The block offset and byte-count arrays are not read (they are 1.4 MB each
// for the global file): only where they start, so slices can be fetched.
export function parseGhslHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0) !== 0x4949 || dv.getUint16(2, true) !== 42) throw new Error('unsupported GHSL file format');
  const off = dv.getUint32(4, true);
  const count = dv.getUint16(off, true);
  if (off + 2 + count * 12 > bytes.length) return { need: off + 2 + count * 12 + 1024 };
  const tags = {};
  for (let i = 0; i < count; i++) {
    const e = off + 2 + i * 12;
    const tag = dv.getUint16(e, true);
    const type = dv.getUint16(e + 2, true);
    const n = dv.getUint32(e + 4, true);
    tags[tag] = { type, n, inline: e + 8, ptr: dv.getUint32(e + 8, true) };
  }
  const num = (t) => (tags[t].type === 3 ? dv.getUint16(tags[t].inline, true) : dv.getUint32(tags[t].inline, true));
  const doubles = (t) => {
    const { ptr, n } = tags[t];
    if (ptr + n * 8 > bytes.length) return null;
    return Array.from({ length: n }, (_, k) => dv.getFloat64(ptr + 8 * k, true));
  };
  const scale = doubles(33550);
  const tie = doubles(33922);
  if (!scale || !tie) return { need: Math.max(tags[33550].ptr + 24, tags[33922].ptr + 48) + 1024 };
  if (num(259) !== 8 && num(259) !== 1) throw new Error('unsupported GHSL compression');
  if (num(258) !== 16) throw new Error('unsupported GHSL sample format');
  if (tags[324].type !== 4 || tags[325].type !== 4) throw new Error('unsupported GHSL block index');
  return {
    w: num(256), h: num(257), tw: num(322), th: num(323),
    compressed: num(259) === 8, predictor: tags[317] ? num(317) : 1,
    offsetsAt: tags[324].ptr, countsAt: tags[325].ptr,
    west: tie[3] - tie[0] * scale[0], north: tie[4] + tie[1] * scale[1],
    dx: scale[0], dy: scale[1],
  };
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Undoes TIFF predictor 2 (horizontal differencing) on 16-bit samples.
export function undoPredictor16(v, tw, th) {
  for (let y = 0; y < th; y++) for (let x = 1; x < tw; x++) v[y * tw + x] = (v[y * tw + x] + v[y * tw + x - 1]) & 0xffff;
  return v;
}

let header = null; // Promise<header> for GHSL_URL

function loadHeader(url, signal, fetchImpl) {
  if (header && url === GHSL_URL) return header;
  const p = (async () => {
    let len = 4096;
    for (let i = 0; i < 3; i++) {
      const h = parseGhslHeader(await fetchRange(url, 0, len - 1, signal, fetchImpl));
      if (!h.need) return h;
      len = h.need;
    }
    throw new Error('GHSL file header too large');
  })();
  if (url === GHSL_URL) {
    header = p;
    p.catch(() => (header = null));
  }
  return p;
}

// Built-up surface for bbox [w, s, e, n] at full resolution.
// Returns { west, north, dx, dy, w, h, data: Uint16Array (m² per cell), bytes }.
export async function loadBuiltUp([w, s, e, n], { signal, url = GHSL_URL, fetchImpl = fetch } = {}) {
  const H = await loadHeader(url, signal, fetchImpl);
  const c0 = Math.max(0, Math.floor((w - H.west) / H.dx));
  const c1 = Math.min(H.w - 1, Math.floor((e - H.west) / H.dx));
  const r0 = Math.max(0, Math.floor((H.north - n) / H.dy));
  const r1 = Math.min(H.h - 1, Math.floor((H.north - s) / H.dy));
  if (c1 < c0 || r1 < r0) throw new Error('area outside the GHSL grid');
  const gw = c1 - c0 + 1;
  const gh = r1 - r0 + 1;
  const data = new Uint16Array(gw * gh);
  const across = Math.ceil(H.w / H.tw);
  const bx0 = Math.floor(c0 / H.tw);
  const bx1 = Math.floor(c1 / H.tw);
  const by0 = Math.floor(r0 / H.th);
  const by1 = Math.floor(r1 / H.th);
  let bytes = 0;
  const jobs = [];
  for (let by = by0; by <= by1; by++) {
    jobs.push((async () => {
      // Offsets and byte counts of this row's blocks: two small range requests.
      const i0 = by * across + bx0;
      const nb = bx1 - bx0 + 1;
      const [ob, cb] = await Promise.all([
        fetchRange(url, H.offsetsAt + 4 * i0, H.offsetsAt + 4 * (i0 + nb) - 1, signal, fetchImpl),
        fetchRange(url, H.countsAt + 4 * i0, H.countsAt + 4 * (i0 + nb) - 1, signal, fetchImpl),
      ]);
      const ov = new DataView(ob.buffer, ob.byteOffset, ob.byteLength);
      const cv = new DataView(cb.buffer, cb.byteOffset, cb.byteLength);
      await Promise.all(Array.from({ length: nb }, async (_, k) => {
        const off = ov.getUint32(4 * k, true);
        const len = cv.getUint32(4 * k, true);
        if (!len) return; // empty block: no built-up surface
        const raw = await fetchRange(url, off, off + len - 1, signal, fetchImpl);
        bytes += raw.length;
        const dec = H.compressed ? await inflate(raw) : raw;
        let v = new Uint16Array(dec.buffer.slice(dec.byteOffset, dec.byteOffset + H.tw * H.th * 2));
        if (H.predictor === 2) v = undoPredictor16(v, H.tw, H.th);
        const bx = bx0 + k;
        // Copy the part of the block inside the requested window.
        const ys = Math.max(r0, by * H.th);
        const ye = Math.min(r1, by * H.th + H.th - 1);
        const xs = Math.max(c0, bx * H.tw);
        const xe = Math.min(c1, bx * H.tw + H.tw - 1);
        for (let r = ys; r <= ye; r++) {
          const src = (r - by * H.th) * H.tw - bx * H.tw;
          const dst = (r - r0) * gw - c0;
          for (let c = xs; c <= xe; c++) data[dst + c] = v[src + c];
        }
      }));
    })());
  }
  await Promise.all(jobs);
  return { west: H.west + c0 * H.dx, north: H.north - r0 * H.dy, dx: H.dx, dy: H.dy, w: gw, h: gh, data, bytes };
}
