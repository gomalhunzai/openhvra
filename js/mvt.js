// Minimal Mapbox Vector Tile (MVT 2.1) decoder: polygon features of one
// layer, with their properties, converted to longitude/latitude.
// Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

class Pbf {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  varint() {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 128;
    }
  }
  svarint() {
    const v = this.varint();
    return v % 2 === 1 ? (v + 1) / -2 : v / 2;
  }
  bytes() {
    const n = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(type) {
    if (type === 0) this.varint();
    else if (type === 1) this.pos += 8;
    else if (type === 2) this.pos += this.varint();
    else if (type === 5) this.pos += 4;
    else throw new Error(`unsupported protobuf wire type ${type}`);
  }
  // Calls fn(field, type) for each field until `end`.
  fields(end, fn) {
    while (this.pos < end) {
      const tag = this.varint();
      fn(tag >> 3, tag & 7);
    }
  }
}

const utf8 = new TextDecoder();

function readValue(p) {
  const end = p.varint() + p.pos;
  let v = null;
  p.fields(end, (f, t) => {
    if (f === 1) v = utf8.decode(p.bytes());
    else if (f === 2) { v = p.dv.getFloat32(p.pos, true); p.pos += 4; }
    else if (f === 3) { v = p.dv.getFloat64(p.pos, true); p.pos += 8; }
    else if (f === 4 || f === 5) v = p.varint();
    else if (f === 6) v = p.svarint();
    else if (f === 7) v = !!p.varint();
    else p.skip(t);
  });
  return v;
}

function packed(p) {
  const end = p.varint() + p.pos;
  const out = [];
  while (p.pos < end) out.push(p.varint());
  return out;
}

// Rings in tile coordinates from a geometry command stream.
function rings(cmds) {
  const out = [];
  let x = 0;
  let y = 0;
  let ring = null;
  for (let i = 0; i < cmds.length;) {
    const c = cmds[i++];
    const id = c & 7;
    const n = c >> 3;
    if (id === 7) {
      if (ring?.length) ring.push(ring[0]);
      continue;
    }
    for (let k = 0; k < n; k++) {
      const dx = cmds[i++];
      const dy = cmds[i++];
      x += dx % 2 === 1 ? (dx + 1) / -2 : dx / 2;
      y += dy % 2 === 1 ? (dy + 1) / -2 : dy / 2;
      if (id === 1) out.push((ring = [[x, y]]));
      else ring.push([x, y]);
    }
  }
  return out;
}

// Signed area (tile coordinates, y down): exterior rings are positive.
function signedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[i][1] + r[j][1]);
  return a;
}

// Polygon features of layer `name` in tile z/x/y as GeoJSON-like objects
// { properties, polygons: [[outer, ...holes], ...] } in [lon, lat].
export function decodePolygons(bytes, name, z, x, y) {
  return decode(bytes, name, z, x, y, 3);
}

// Point features of layer `name` as { properties, points: [[lon, lat], ...] }.
export function decodePoints(bytes, name, z, x, y) {
  return decode(bytes, name, z, x, y, 1);
}

function decode(bytes, name, z, x, y, wanted) {
  const p = new Pbf(bytes);
  const out = [];
  p.fields(bytes.length, (f, t) => {
    if (f !== 3) return p.skip(t);
    const end = p.varint() + p.pos;
    let lname = '';
    let extent = 4096;
    const keys = [];
    const values = [];
    const feats = [];
    p.fields(end, (lf, lt) => {
      if (lf === 1) lname = utf8.decode(p.bytes());
      else if (lf === 2) feats.push(p.bytes());
      else if (lf === 3) keys.push(utf8.decode(p.bytes()));
      else if (lf === 4) values.push(readValue(p));
      else if (lf === 5) extent = p.varint();
      else p.skip(lt);
    });
    if (lname !== name) return;
    const n = 2 ** z;
    const lon = (tx) => ((x + tx / extent) / n) * 360 - 180;
    const lat = (ty) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + ty / extent)) / n))) * 180) / Math.PI;
    for (const fb of feats) {
      const q = new Pbf(fb);
      let type = 0;
      let tags = [];
      let geom = [];
      q.fields(fb.length, (ff, ft) => {
        if (ff === 2) tags = packed(q);
        else if (ff === 3) type = q.varint();
        else if (ff === 4) geom = packed(q);
        else q.skip(ft);
      });
      if (type !== wanted) continue;
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      if (wanted === 1) {
        const points = [];
        let px = 0;
        let py = 0;
        for (let i = 0; i < geom.length;) {
          const n = geom[i++] >> 3;
          for (let k = 0; k < n; k++) {
            const dx = geom[i++];
            const dy = geom[i++];
            px += dx % 2 === 1 ? (dx + 1) / -2 : dx / 2;
            py += dy % 2 === 1 ? (dy + 1) / -2 : dy / 2;
            points.push([lon(px), lat(py)]);
          }
        }
        if (points.length) out.push({ properties: props, points });
        continue;
      }
      const polygons = [];
      for (const r of rings(geom)) {
        if (r.length < 4) continue;
        const ll = r.map(([tx, ty]) => [lon(tx), lat(ty)]);
        if (signedArea(r) > 0 || !polygons.length) polygons.push([ll]);
        else polygons[polygons.length - 1].push(ll);
      }
      if (polygons.length) out.push({ properties: props, polygons });
    }
  });
  return out;
}
