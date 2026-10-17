// Spatial analysis over a loaded OSM extract: population model, live cursor
// probe and whole-area exposure (features within X m of a hazard source).

import { makeProjection, GridIndex, nearestOnSeg, segLenInCircle, pointInRing, ringBBox } from './spatial.js';

export const SOURCES = {
  water_all: { label: 'All waterways', short: 'any waterway', pred: (l) => l.kind === 'water' },
  water_river: { label: 'Rivers & canals', short: 'a river or canal', pred: (l) => l.kind === 'water' && l.cls === 'river' },
  water_stream: { label: 'Streams, drains & ditches', short: 'a stream, drain or ditch', pred: (l) => l.kind === 'water' && l.cls === 'stream' },
  road_major: { label: 'Major roads', short: 'a major road', pred: (l) => l.kind === 'road' && l.cls === 'major' },
  road_all: { label: 'All roads (no footpaths)', short: 'any road', pred: (l) => l.kind === 'road' && l.cls !== 'path' },
};

export const DEFAULT_POP = {
  m2PerPerson: 20, // floor area per resident; ~10–15 in dense South Asian housing, 40+ in Europe
  defaultLevels: 1, // storeys assumed when building:levels is missing
  unknownResidential: true, // treat untagged building=yes as homes
  knownTotal: 0, // optional census figure for the area; rescales all estimates
  pointArea: 80, // footprint assumed for buildings mapped without an outline
  minArea: 15, // smaller structures are assumed uninhabited
};

export class Dataset {
  // `aoi` is an optional list of polygons [[outer, ...holes], ...] of [lon, lat]
  // rings; features outside it are dropped.
  constructor(parsed, bbox, aoi = null) {
    const [w, s, e, n] = bbox;
    this.bbox = bbox;
    this.parsed = parsed;
    this.proj = makeProjection((w + e) / 2, (s + n) / 2);
    this.aoi = aoi
      ? aoi.map((poly) => {
          const rings = poly.map((ring) => ring.map(([lon, lat]) => this.proj.toXY(lon, lat)));
          return { rings, bbox: ringBBox(rings[0]) };
        })
      : null;
    this.points = [];
    this.lines = [];
    this.pointIndex = new GridIndex(50);
    this.segIndex = new GridIndex(100);
    for (const f of parsed.buildings) this._addPoint(f);
    for (const f of parsed.facilities) this._addPoint(f);
    for (const f of parsed.waterways) this._addLine(f);
    for (const f of parsed.roads) this._addLine(f);
    this.buildings = this.points.filter((p) => p.kind === 'building');
    this.facilities = this.points.filter((p) => p.kind === 'facility');
    this.setPopulation(DEFAULT_POP);
  }

  _inAOI(x, y) {
    if (!this.aoi) return true;
    return this.aoi.some(({ rings, bbox: [w, s, e, n] }) =>
      x >= w && x <= e && y >= s && y <= n && pointInRing(x, y, rings[0]) && !rings.slice(1).some((h) => pointInRing(x, y, h)));
  }

  _addPoint(f) {
    const [x, y] = this.proj.toXY(...f.center);
    if (!this._inAOI(x, y)) return;
    const p = { ...f.properties, x, y, feature: f, pop: 0 };
    this.points.push(p);
    this.pointIndex.insert(p, x, y, x, y);
  }

  _addLine(f) {
    // Lines are kept even outside the AOI so "nearest river" stays correct at
    // its edge; only the part inside counts towards totals.
    const line = { ...f.properties, feature: f, length: 0, lengthInAOI: 0 };
    const xy = f.geometry.coordinates.map(([lon, lat]) => this.proj.toXY(lon, lat));
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1];
      const [bx, by] = xy[i];
      const len = Math.hypot(bx - ax, by - ay);
      line.length += len;
      if (this._inAOI((ax + bx) / 2, (ay + by) / 2)) line.lengthInAOI += len;
      const seg = { line, ax, ay, bx, by };
      this.segIndex.insert(seg, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
    }
    this.lines.push(line);
  }

  contains(lon, lat) {
    const [w, s, e, n] = this.bbox;
    if (lon < w || lon > e || lat < s || lat > n) return false;
    return this._inAOI(...this.proj.toXY(lon, lat));
  }

  // ---- Population (dasymetric: residential floor area / area per person) ----

  setPopulation(params) {
    this.popParams = { ...DEFAULT_POP, ...params };
    const P = this.popParams;
    let raw = 0;
    for (const b of this.buildings) {
      const residential = b.cls === 'residential' || (b.cls === 'unknown' && P.unknownResidential);
      const area = b.area ?? P.pointArea;
      b.floors = b.levels ?? P.defaultLevels;
      b.footprint = area;
      b.pop = residential && area >= P.minArea ? (area * b.floors) / P.m2PerPerson : 0;
      raw += b.pop;
    }
    this.popFactor = P.knownTotal > 0 && raw > 0 ? P.knownTotal / raw : 1;
    if (this.popFactor !== 1) for (const b of this.buildings) b.pop *= this.popFactor;
    this.popTotal = raw * this.popFactor;
    return this.popTotal;
  }

  summary() {
    const classes = {};
    for (const b of this.buildings) {
      const c = (classes[b.cls] ??= { count: 0, pop: 0, area: 0 });
      c.count++;
      c.pop += b.pop;
      c.area += b.footprint * b.floors;
    }
    const groups = {};
    for (const f of this.facilities) groups[f.group] = (groups[f.group] ?? 0) + 1;
    const len = { road: 0, water: 0 };
    for (const l of this.lines) len[l.kind] += l.lengthInAOI;
    return { classes, groups, len, pop: this.popTotal, buildings: this.buildings.length, facilities: this.facilities.length };
  }

  // Nearest segment matching `pred` within `maxR` metres, searching outwards.
  nearest(x, y, pred, maxR = 4000) {
    const radii = [250, 1000, 4000].filter((r) => r < maxR).concat(maxR);
    for (const r of radii) {
      let best = null;
      this.segIndex.query(x - r, y - r, x + r, y + r, (s) => {
        if (!pred(s.line)) return;
        const hit = nearestOnSeg(x, y, s.ax, s.ay, s.bx, s.by);
        if (!best || hit.d < best.d) best = { ...hit, line: s.line };
      });
      if (best && best.d <= r) {
        best.lonlat = this.proj.toLonLat(best.x, best.y);
        return best;
      }
    }
    return null;
  }

  // Nearest point (building/facility) matching `pred` within `maxR` metres.
  nearestPoint(x, y, pred, maxR = 5000) {
    const radii = [500, 2000].filter((r) => r < maxR).concat(maxR);
    for (const r of radii) {
      let best = null;
      this.pointIndex.query(x - r, y - r, x + r, y + r, (p) => {
        if (!pred(p)) return;
        const d = Math.hypot(p.x - x, p.y - y);
        if (!best || d < best.d) best = { p, d };
      });
      if (best && best.d <= r) return best;
    }
    return null;
  }

  probe(lon, lat, r) {
    const [x, y] = this.proj.toXY(lon, lat);
    const res = {
      buildings: 0,
      pop: 0,
      facilities: [],
      groups: {},
      roadLen: { major: 0, minor: 0, path: 0 },
      waterLen: { river: 0, stream: 0 },
      hits: [],
    };
    this.pointIndex.query(x - r, y - r, x + r, y + r, (p) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d > r) return;
      res.hits.push(p);
      if (p.kind === 'building') {
        res.buildings++;
        res.pop += p.pop;
      } else {
        res.facilities.push({ p, d });
        res.groups[p.group] = (res.groups[p.group] ?? 0) + 1;
      }
    });
    res.facilities.sort((a, b) => a.d - b.d);
    this.segIndex.query(x - r, y - r, x + r, y + r, (s) => {
      const len = segLenInCircle(x, y, r, s.ax, s.ay, s.bx, s.by);
      if (!len) return;
      if (s.line.kind === 'road') res.roadLen[s.line.cls] += len;
      else res.waterLen[s.line.cls] += len;
    });
    res.nearestWater = this.nearest(x, y, SOURCES.water_all.pred);
    res.nearestRiver = this.nearest(x, y, SOURCES.water_river.pred);
    res.nearestRoad = this.nearest(x, y, SOURCES.road_major.pred);
    return res;
  }

  // Every building/facility whose centre lies within `dist` m of a source line.
  exposure(sourceKey, dist) {
    const pred = SOURCES[sourceKey].pred;
    const hits = [];
    for (const p of this.points) {
      let best = Infinity;
      this.segIndex.query(p.x - dist, p.y - dist, p.x + dist, p.y + dist, (s) => {
        if (!pred(s.line)) return;
        const { d } = nearestOnSeg(p.x, p.y, s.ax, s.ay, s.bx, s.by);
        if (d < best) best = d;
      });
      if (best <= dist) hits.push({ p, d: best });
    }
    hits.sort((a, b) => a.d - b.d);
    const groups = {};
    let buildings = 0;
    let pop = 0;
    for (const { p } of hits) {
      if (p.kind === 'building') {
        buildings++;
        pop += p.pop;
      } else groups[p.group] = (groups[p.group] ?? 0) + 1;
    }
    const sourceLines = this.lines.filter(pred);
    return {
      sourceKey,
      dist,
      hits,
      buildings,
      pop,
      groups,
      totals: { buildings: this.buildings.length, facilities: this.facilities.length, pop: this.popTotal },
      sourceLines,
      sourceLength: sourceLines.reduce((a, l) => a + l.lengthInAOI, 0),
    };
  }
}
