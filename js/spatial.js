// Lightweight geometry helpers. All analysis runs in a local metric plane
// (equirectangular projection around the loaded area's centre), which is
// accurate to well under 1% for the few-km areas this app works with.

export function makeProjection(lon0, lat0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110574;
  return {
    toXY: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: (x, y) => [x / kx + lon0, y / ky + lat0],
  };
}

// Uniform grid spatial hash. Items are inserted into every cell their bbox
// touches; queries de-duplicate with a per-query stamp.
export class GridIndex {
  constructor(size = 100) {
    this.size = size;
    this.cells = new Map();
    this.stamp = 0;
  }
  _k(i, j) {
    return (i + 32768) * 65536 + (j + 32768);
  }
  insert(item, minX, minY, maxX, maxY) {
    const s = this.size;
    for (let i = Math.floor(minX / s); i <= Math.floor(maxX / s); i++) {
      for (let j = Math.floor(minY / s); j <= Math.floor(maxY / s); j++) {
        const k = this._k(i, j);
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = []));
        cell.push(item);
      }
    }
  }
  query(minX, minY, maxX, maxY, cb) {
    const s = this.size;
    const st = ++this.stamp;
    for (let i = Math.floor(minX / s); i <= Math.floor(maxX / s); i++) {
      for (let j = Math.floor(minY / s); j <= Math.floor(maxY / s); j++) {
        const cell = this.cells.get(this._k(i, j));
        if (!cell) continue;
        for (const item of cell) {
          if (item._s === st) continue;
          item._s = st;
          cb(item);
        }
      }
    }
  }
}

// Distance from point P to segment AB, plus the closest point on AB.
export function nearestOnSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { d: Math.hypot(px - x, py - y), x, y };
}

// Length of segment AB that lies inside the circle (P, r).
export function segLenInCircle(px, py, r, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - px;
  const fy = ay - py;
  const a = dx * dx + dy * dy;
  if (!a) return 0;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return 0;
  const s = Math.sqrt(disc);
  const t1 = Math.max(0, (-b - s) / (2 * a));
  const t2 = Math.min(1, (-b + s) / (2 * a));
  return t2 > t1 ? (t2 - t1) * Math.sqrt(a) : 0;
}

// Closed ring [[lon, lat], ...] approximating a circle of radius r metres.
export function circleRing(lon, lat, r, steps = 72) {
  const p = makeProjection(lon, lat);
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push(p.toLonLat(r * Math.cos(a), r * Math.sin(a)));
  }
  return ring;
}

export function circlePolygon(lon, lat, r, steps = 72) {
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleRing(lon, lat, r, steps)] } };
}

// Shoelace area of a ring of [x, y] metre coordinates.
export function ringArea(xy) {
  let a = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) a += (xy[j][0] + xy[i][0]) * (xy[j][1] - xy[i][1]);
  return Math.abs(a / 2);
}

// Area in m² of a [lon, lat] ring.
export function lonLatArea(coords) {
  const p = makeProjection(coords[0][0], coords[0][1]);
  return ringArea(coords.map(([lon, lat]) => p.toXY(lon, lat)));
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function ringBBox(ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

// Approximate area in km² of a [w, s, e, n] box.
export function bboxAreaKm2([w, s, e, n]) {
  return (e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180) * (n - s) * 110.57;
}
