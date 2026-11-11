// Minimal reader for PMTiles v3 archives (one file of map tiles with a
// tile directory), read with HTTP range requests. Only what OpenHVRA needs:
// look up and fetch single tiles. Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
//
// Directories and tiles are usually gzip-compressed; the browser's own
// DecompressionStream unpacks them, so no library is needed.

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const decompress = (bytes, c) => (c === 2 ? gunzip(bytes) : c === 1 ? bytes : Promise.reject(new Error('unsupported PMTiles compression')));

export function parsePmHeader(b) {
  if (String.fromCharCode(...b.subarray(0, 7)) !== 'PMTiles' || b[7] !== 3) throw new Error('not a PMTiles v3 file');
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u64 = (o) => Number(d.getBigUint64(o, true));
  return {
    rootOff: u64(8), rootLen: u64(16), leafOff: u64(40), dataOff: u64(56),
    internalComp: b[97], tileComp: b[98], tileType: b[99], minZoom: b[100], maxZoom: b[101],
  };
}

// Hilbert-curve tile id, as in the spec.
export function zxyToTileId(z, x, y) {
  let acc = 0;
  for (let t = 0; t < z; t++) acc += 4 ** t;
  const n = 2 ** z;
  let d = 0;
  let rx; let ry;
  for (let s = n / 2; s >= 1; s /= 2) {
    rx = (x & s) > 0 ? 1 : 0;
    ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      [x, y] = [y, x];
    }
  }
  return acc + d;
}

function readVarint(b, pos) {
  let v = 0;
  let mul = 1;
  for (;;) {
    const byte = b[pos.i++];
    v += (byte & 0x7f) * mul;
    if (byte < 0x80) return v;
    mul *= 128;
  }
}

// Directory entries: [{ tileId, offset, length, runLength }].
export function parseDirectory(b) {
  const pos = { i: 0 };
  const n = readVarint(b, pos);
  const e = Array.from({ length: n }, () => ({ tileId: 0, offset: 0, length: 0, runLength: 0 }));
  let last = 0;
  for (const x of e) x.tileId = last += readVarint(b, pos);
  for (const x of e) x.runLength = readVarint(b, pos);
  for (const x of e) x.length = readVarint(b, pos);
  e.forEach((x, i) => {
    const v = readVarint(b, pos);
    x.offset = v === 0 && i > 0 ? e[i - 1].offset + e[i - 1].length : v - 1;
  });
  return e;
}

function findEntry(entries, id) {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].tileId < id) lo = mid + 1;
    else if (entries[mid].tileId > id) hi = mid - 1;
    else return entries[mid];
  }
  // A run of identical tiles, or a leaf directory (runLength 0) covering ids from its tileId.
  const e = entries[hi];
  if (e && (e.runLength === 0 || id - e.tileId < e.runLength)) return e;
  return null;
}

export class PMTiles {
  constructor(url, fetchImpl = fetch) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.dirs = new Map(); // offset → Promise<entries>
  }

  async _range(off, len, signal) {
    const fetchImpl = this.fetchImpl; // called as a plain function: browsers reject fetch with another `this`
    const res = await fetchImpl(this.url, { signal, headers: { Range: `bytes=${off}-${off + len - 1}` } });
    if (!res.ok) throw new Error(`tile download failed (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  header(signal) {
    this._header ??= (async () => {
      const b = await this._range(0, 16384, signal);
      const h = parsePmHeader(b);
      // The root directory usually sits inside the first 16 kB.
      const raw = h.rootOff + h.rootLen <= b.length ? b.slice(h.rootOff, h.rootOff + h.rootLen) : await this._range(h.rootOff, h.rootLen, signal);
      this.dirs.set(`root`, Promise.resolve(parseDirectory(await decompress(raw, h.internalComp))));
      return h;
    })();
    this._header.catch(() => (this._header = null));
    return this._header;
  }

  _leaf(off, len, h, signal) {
    const key = `${off}`;
    if (!this.dirs.has(key)) {
      const p = this._range(h.leafOff + off, len, signal).then((raw) => decompress(raw, h.internalComp)).then(parseDirectory);
      this.dirs.set(key, p);
      p.catch(() => this.dirs.delete(key));
    }
    return this.dirs.get(key);
  }

  // Decompressed tile bytes, or null if the archive has no such tile.
  async getTile(z, x, y, signal) {
    const h = await this.header(signal);
    const id = zxyToTileId(z, x, y);
    let entries = await this.dirs.get('root');
    for (let depth = 0; depth < 4; depth++) {
      const e = findEntry(entries, id);
      if (!e) return null;
      if (e.runLength > 0) return decompress(await this._range(h.dataOff + e.offset, e.length, signal), h.tileComp);
      entries = await this._leaf(e.offset, e.length, h, signal);
    }
    throw new Error('PMTiles directory too deep');
  }
}
