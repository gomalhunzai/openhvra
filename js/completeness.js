// How complete are the OSM buildings? Compares the footprint area of the
// loaded OSM buildings with an independent satellite-derived reference, the
// GHSL built-up surface (ghsl.js), cell by cell and in blocks of a few cells.
//
// Both measure roofed area, so where OSM is fully mapped the ratio is close
// to 1. A low ratio means buildings are probably missing from OSM; a ratio
// above 1 can mean buildings built since 2020 or built-up area that GHSL
// missed (its accuracy varies by place; it can miss small, closely packed
// buildings).

// Blocks of 3 × 3 GHSL cells (about 270 m north–south).
export const BLOCK_CELLS = 3;
// Blocks with less reference built-up area than this (about five small
// houses) are not classed: the ratio would be dominated by noise.
export const MIN_REF_M2 = 500;

export const COMPLETENESS_CLASSES = [
  { max: 0.25, label: 'Under 25%', color: '#3f1d7a' },
  { max: 0.5, label: '25–50%', color: '#6c47c4' },
  { max: 0.8, label: '50–80%', color: '#a993e0' },
  { max: Infinity, label: '80% or more', color: '#e5ddf7' },
];
export const completenessClass = (ratio) => COMPLETENESS_CLASSES.findIndex((c) => ratio < c.max);

// Overall rating shown in step 1 and in the exports.
export function completenessRating(ratio) {
  if (ratio >= 0.8) return { key: 'good', label: 'mostly complete' };
  if (ratio >= 0.5) return { key: 'partial', label: 'partly complete' };
  return { key: 'low', label: 'very incomplete' };
}

// grid: { west, north, dx, dy, w, h, data } from loadBuiltUp (m² per cell).
// buildings: [{ lon, lat, area }] already limited to the area of interest.
// contains(lon, lat): whether a point lies in the area of interest.
export function computeCompleteness(grid, buildings, contains, { block = BLOCK_CELLS, minRef = MIN_REF_M2 } = {}) {
  const { west, north, dx, dy, w, h, data } = grid;
  const osm = new Float64Array(w * h);
  let osmOutside = 0; // OSM area in cells outside the grid (should be none)
  for (const b of buildings) {
    const c = Math.floor((b.lon - west) / dx);
    const r = Math.floor((north - b.lat) / dy);
    if (c < 0 || r < 0 || c >= w || r >= h) osmOutside += b.area;
    else osm[r * w + c] += b.area;
  }
  const blocks = [];
  let refTotal = 0;
  let osmTotal = 0;
  let missing = 0;
  let refInLow = 0; // reference area in blocks where OSM has under half of it
  for (let br = 0; br < h; br += block) {
    for (let bc = 0; bc < w; bc += block) {
      let ref = 0;
      let o = 0;
      let inside = 0;
      for (let r = br; r < Math.min(h, br + block); r++) {
        for (let c = bc; c < Math.min(w, bc + block); c++) {
          o += osm[r * w + c];
          if (contains(west + (c + 0.5) * dx, north - (r + 0.5) * dy)) {
            ref += data[r * w + c];
            inside++;
          }
        }
      }
      if (!inside && !o) continue;
      refTotal += ref;
      osmTotal += o;
      if (ref < minRef) continue;
      const ratio = o / ref;
      missing += Math.max(0, ref - o);
      if (ratio < 0.5) refInLow += ref;
      const x0 = west + bc * dx;
      const y0 = north - br * dy;
      blocks.push({
        ref, osm: o, ratio, cls: completenessClass(ratio),
        bbox: [x0, y0 - Math.min(block, h - br) * dy, x0 + Math.min(block, w - bc) * dx, y0],
      });
    }
  }
  osmTotal += osmOutside;
  const ratio = refTotal > 0 ? osmTotal / refTotal : null;
  return {
    ratio, refTotal, osmTotal, missing,
    lowShare: refTotal > 0 ? refInLow / refTotal : 0,
    rating: ratio == null ? null : completenessRating(ratio),
    blocks,
    classCounts: COMPLETENESS_CLASSES.map((_, i) => blocks.filter((b) => b.cls === i).length),
  };
}

// Map polygons, one per classed block.
export function completenessGeoJSON(result) {
  return {
    type: 'FeatureCollection',
    features: result.blocks.map((b) => {
      const [w, s, e, n] = b.bbox;
      return {
        type: 'Feature',
        properties: { cls: b.cls, pct: Math.round(100 * b.ratio), ref_m2: Math.round(b.ref), osm_m2: Math.round(b.osm) },
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      };
    }),
  };
}
