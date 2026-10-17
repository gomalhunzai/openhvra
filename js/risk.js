// Flood risk and risk-finance model.
//
// Hazard: a "height above nearest drainage" (HAND) proxy. Each building's
// ground elevation is compared with the channel elevation at its nearest
// waterway; a flood scenario raising water `level` metres above the channel
// gives a depth of `level - HAND` at that building. Elevation comes from the
// open AWS Terrain Tiles (Terrarium PNGs, mostly SRTM/NASADEM ~30 m).
//
// Vulnerability: depth-damage curves, approximately the JRC global flood
// depth-damage functions for Asia (Huizinga et al. 2017).
//
// Risk metrics: losses per return period, average annual loss (AAL) by
// trapezoidal integration of the loss-exceedance curve, and a simple
// risk-layering view for disaster risk finance.

import { SOURCES } from './analysis.js';
import { CRITICAL_GROUPS } from './osm.js';

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// ---- Elevation ------------------------------------------------------------------

function lonToPx(lon, z) {
  return ((lon + 180) / 360) * 256 * 2 ** z;
}
function latToPx(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z;
}

async function decodeTerrarium(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(256, 256)
    : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, 256, 256).data;
  const out = new Float32Array(256 * 256);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  return out;
}

export class DEM {
  constructor(z, x0, y0, nx, ny, tiles) {
    Object.assign(this, { z, x0, y0, nx, ny, tiles });
  }
  _at(ix, iy) {
    const tx = Math.floor(ix / 256);
    const ty = Math.floor(iy / 256);
    if (tx < 0 || ty < 0 || tx >= this.nx || ty >= this.ny) return NaN;
    const t = this.tiles[ty * this.nx + tx];
    return t ? t[(iy - ty * 256) * 256 + (ix - tx * 256)] : NaN;
  }
  _sample(px, py) {
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = px - ix;
    const fy = py - iy;
    const a = this._at(ix, iy);
    const b = this._at(ix + 1, iy);
    const c = this._at(ix, iy + 1);
    const d = this._at(ix + 1, iy + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }
  _px(lon, lat) {
    return [lonToPx(lon, this.z) - this.x0 * 256 - 0.5, latToPx(lat, this.z) - this.y0 * 256 - 0.5];
  }
  // Pixel-space access for analyses that sample many nearby points.
  pixel(lon, lat) {
    return this._px(lon, lat);
  }
  sample(px, py) {
    return this._sample(px, py);
  }
  metresPerPixel(lat) {
    return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** this.z);
  }
  elev(lon, lat) {
    return this._sample(...this._px(lon, lat));
  }
  // Lowest elevation within r pixels: approximates the channel bed.
  minAround(lon, lat, r = 2) {
    const [px, py] = this._px(lon, lat);
    let min = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const v = this._at(Math.round(px) + dx, Math.round(py) + dy);
        if (v < min) min = v;
      }
    }
    return Number.isFinite(min) ? min : NaN;
  }
  slopeDeg(lon, lat) {
    const [px, py] = this._px(lon, lat);
    const k = 2; // sample ±2 px: the source data is coarser than the tiles
    const size = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** this.z);
    const dzdx = (this._sample(px + k, py) - this._sample(px - k, py)) / (2 * k * size);
    const dzdy = (this._sample(px, py + k) - this._sample(px, py - k)) / (2 * k * size);
    return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
  }
}

// Fetch Terrarium tiles covering bbox at the finest zoom (≤14) needing ≤ 36 tiles.
export async function loadDEM([w, s, e, n], { signal, onProgress } = {}) {
  let z = 14;
  let x0, x1, y0, y1;
  for (; z >= 8; z--) {
    x0 = Math.floor(lonToPx(w, z) / 256);
    x1 = Math.floor(lonToPx(e, z) / 256);
    y0 = Math.floor(latToPx(n, z) / 256);
    y1 = Math.floor(latToPx(s, z) / 256);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 36) break;
  }
  const nx = x1 - x0 + 1;
  const ny = y1 - y0 + 1;
  let done = 0;
  const tiles = await Promise.all(
    Array.from({ length: nx * ny }, async (_, i) => {
      const x = x0 + (i % nx);
      const y = y0 + Math.floor(i / nx);
      try {
        const res = await fetch(`${TERRARIUM}/${z}/${x}/${y}.png`, { signal });
        if (!res.ok) return null;
        return await decodeTerrarium(await res.blob());
      } catch (err) {
        if (signal?.aborted) throw err;
        return null;
      } finally {
        onProgress?.(++done, nx * ny);
      }
    }),
  );
  if (tiles.every((t) => !t)) throw new Error('elevation tiles could not be downloaded');
  return new DEM(z, x0, y0, nx, ny, tiles);
}

// ---- Vulnerability ----------------------------------------------------------------

export const DAMAGE_CURVES = {
  depths: [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6],
  residential: [0, 0.33, 0.49, 0.62, 0.72, 0.87, 0.93, 0.98, 1],
  commercial: [0, 0.38, 0.54, 0.66, 0.76, 0.88, 0.94, 0.98, 1],
  industrial: [0, 0.28, 0.48, 0.63, 0.72, 0.86, 0.91, 0.96, 1],
};
const CURVE_FOR = { residential: 'residential', unknown: 'residential', commercial: 'commercial', public: 'commercial', industrial: 'industrial', ancillary: 'industrial' };

export function damageFraction(curve, depth) {
  const { depths } = DAMAGE_CURVES;
  if (depth <= 0) return 0;
  for (let i = 1; i < depths.length; i++) {
    if (depth <= depths[i]) {
      const t = (depth - depths[i - 1]) / (depths[i] - depths[i - 1]);
      return curve[i - 1] + t * (curve[i] - curve[i - 1]);
    }
  }
  return curve[curve.length - 1];
}

// ---- Defaults (placeholders: replace with local hydrology and construction costs) ----

export const DEFAULT_SCENARIOS = [
  { rp: 5, level: 1 },
  { rp: 10, level: 1.5 },
  { rp: 25, level: 2 },
  { rp: 50, level: 2.5 },
  { rp: 100, level: 3 },
  { rp: 500, level: 4 },
];
// Replacement cost per m² of floor area.
export const DEFAULT_COSTS = { residential: 250, commercial: 400, industrial: 300, public: 450, ancillary: 100, unknown: 250 };
export const DEFAULT_FINANCE = { retentionRP: 10, creditRP: 25, transferRP: 100, transferMultiple: 2, creditFeePct: 0.5 };

// ---- Risk ---------------------------------------------------------------------------

// Expected annual value of an event-based quantity from return-period points
// [{ rp, v }] sorted by rp ascending. Nothing is counted for events more
// frequent than the first scenario; events rarer than the last are assumed to
// cause the last scenario's value.
export function expectedAnnual(points) {
  let s = 0;
  for (let i = 0; i < points.length - 1; i++) {
    s += (1 / points[i].rp - 1 / points[i + 1].rp) * ((points[i].v + points[i + 1].v) / 2);
  }
  const last = points[points.length - 1];
  return last ? s + last.v / last.rp : 0;
}

function floodLoss(p, depth, P) {
  const df = damageFraction(DAMAGE_CURVES[CURVE_FOR[p.cls]], depth);
  const floorsHit = Math.min(p.floors, Math.max(1, Math.ceil(depth / 3)));
  return P.costs[p.cls] * p.footprint * floorsHit * (1 + P.contentsPct / 100) * df;
}

// P: { source, maxDist, scenarios: [{rp, level}], costs: {cls: perM2}, contentsPct }
export function floodRisk(ds, dem, P) {
  const pred = SOURCES[P.source].pred;
  const sc = P.scenarios.filter((s) => s.rp > 1 && s.level > 0).sort((a, b) => a.rp - b.rp);
  const res = sc.map((s) => ({ ...s, buildings: 0, pop: 0, loss: 0, groups: {}, facilities: [] }));
  const slope = { moderate: { count: 0, pop: 0 }, steep: { count: 0, pop: 0 } };
  let totalValue = 0;
  let assessed = 0;
  for (const p of ds.points) {
    const [lon, lat] = p.feature.center;
    p.hand = null;
    p.depths = null;
    p.losses = null;
    if (p.kind === 'building') {
      p.value = P.costs[p.cls] * p.footprint * p.floors * (1 + P.contentsPct / 100);
      totalValue += p.value;
      p.slope = dem.slopeDeg(lon, lat);
      if (p.slope >= 25) {
        slope.steep.count++;
        slope.steep.pop += p.pop;
      } else if (p.slope >= 15) {
        slope.moderate.count++;
        slope.moderate.pop += p.pop;
      }
    }
    const nr = ds.nearest(p.x, p.y, pred, P.maxDist);
    if (!nr) continue;
    const eb = dem.elev(lon, lat);
    const er = dem.minAround(nr.lonlat[0], nr.lonlat[1], 2);
    if (!Number.isFinite(eb) || !Number.isFinite(er)) continue;
    assessed++;
    p.hand = Math.max(0, eb - er);
    p.riverDist = nr.d;
    p.depths = sc.map((s) => Math.max(0, s.level - p.hand));
    if (p.kind === 'building') p.losses = p.depths.map((d) => (d > 0 ? floodLoss(p, d, P) : 0));
    p.depths.forEach((d, i) => {
      if (d <= 0) return;
      const r = res[i];
      if (p.kind === 'building') {
        r.buildings++;
        r.pop += p.pop;
        r.loss += p.losses[i];
      } else {
        r.groups[p.group] = (r.groups[p.group] ?? 0) + 1;
        if (CRITICAL_GROUPS.has(p.group)) r.facilities.push({ p, depth: d });
      }
    });
  }
  for (const r of res) r.facilities.sort((a, b) => b.depth - a.depth);
  const curve = res.map((r) => ({ rp: r.rp, loss: r.loss }));
  return {
    scenarios: res,
    curve,
    totalValue,
    aal: expectedAnnual(curve.map((c) => ({ rp: c.rp, v: c.loss }))),
    annualPop: expectedAnnual(res.map((r) => ({ rp: r.rp, v: r.pop }))),
    assessed,
    slope,
    params: P,
  };
}

// Loss at an arbitrary return period, interpolated on log(rp).
export function lossAtRP(curve, rp) {
  if (!curve.length || rp <= 1) return 0;
  if (rp <= curve[0].rp) return (curve[0].loss * Math.log(rp)) / Math.log(curve[0].rp);
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (rp <= b.rp) {
      const t = (Math.log(rp) - Math.log(a.rp)) / (Math.log(b.rp) - Math.log(a.rp));
      return a.loss + t * (b.loss - a.loss);
    }
  }
  return curve[curve.length - 1].loss;
}

// Split losses into a classic risk-layering structure.
export function financeLayers(curve, F) {
  const a = lossAtRP(curve, F.retentionRP);
  const b = Math.max(a, lossAtRP(curve, F.creditRP));
  const c = Math.max(b, lossAtRP(curve, F.transferRP));
  const eal = (lo, hi) => expectedAnnual(curve.map((pt) => ({ rp: pt.rp, v: Math.min(Math.max(pt.loss - lo, 0), hi - lo) })));
  const retention = eal(0, a);
  const credit = eal(a, b);
  const transfer = eal(b, c);
  const residual = eal(c, Infinity);
  return [
    { key: 'retention', name: 'Retain', instrument: 'Contingency budget / reserve fund', rp: `up to ${F.retentionRP}-yr`, from: 0, to: a, eal: retention, cost: retention, costNote: 'annual set-aside = expected loss' },
    { key: 'credit', name: 'Borrow', instrument: 'Contingent credit line', rp: `${F.retentionRP}–${F.creditRP}-yr`, from: a, to: b, eal: credit, cost: ((b - a) * F.creditFeePct) / 100, costNote: `${F.creditFeePct}% commitment fee on the limit` },
    { key: 'transfer', name: 'Transfer', instrument: 'Parametric insurance / cat bond', rp: `${F.creditRP}–${F.transferRP}-yr`, from: b, to: c, eal: transfer, cost: transfer * F.transferMultiple, costNote: `premium ≈ ${F.transferMultiple}× expected loss` },
    { key: 'residual', name: 'Residual', instrument: 'Unfunded: emergency aid, reallocation', rp: `beyond ${F.transferRP}-yr`, from: c, to: Infinity, eal: residual, cost: null, costNote: 'no pre-arranged funding' },
  ];
}
