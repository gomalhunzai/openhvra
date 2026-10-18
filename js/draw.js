// Draw an area of interest on the map: rectangle, circle or polygon.
//   rectangle: click one corner, then the opposite corner
//   circle:    click the centre, then a point on the edge
//   polygon:   click each vertex; double-click, Enter or click the first
//              vertex to finish. Backspace removes the last vertex, Esc cancels.
//   point:     a single click
//   line:      click each vertex; double-click or Enter to finish

import { circleRing, makeProjection } from './spatial.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

export class DrawTool {
  constructor(map, { onFinish, onHint }) {
    this.map = map;
    this.onFinish = onFinish;
    this.onHint = onHint;
    this.mode = null;
    this.pts = [];
    this.cursor = null;
    this.lastHandled = null;
    map.on('click', (e) => this._click(e));
    map.on('dblclick', (e) => this._dblclick(e));
    map.on('mousemove', (e) => {
      if (!this.mode) return;
      this.cursor = [e.lngLat.lng, e.lngLat.lat];
      this._render();
    });
    window.addEventListener('keydown', (e) => this._key(e));
  }

  addLayers() {
    this.map.addSource('draw', { type: 'geojson', data: EMPTY });
    this.map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#7048e8', 'fill-opacity': 0.1 } });
    this.map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#7048e8', 'line-width': 2, 'line-dasharray': [2, 1] } });
    this.map.addLayer({ id: 'draw-pts', type: 'circle', source: 'draw', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#7048e8', 'circle-stroke-width': 2 } });
  }

  // `hint` overrides the default instruction for the mode.
  start(mode, hint) {
    this.cancel(false);
    this.mode = mode;
    this.pts = [];
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.doubleClickZoom.disable();
    this.onHint?.({
      rect: 'Click one corner of the rectangle, then the opposite corner. Esc cancels.',
      circle: 'Click the centre of the circle, then click to set its radius. Esc cancels.',
      polygon: 'Click to add vertices. Double-click, press Enter or click the first point to finish. Esc cancels.',
      point: 'Click a location. Esc cancels.',
      line: 'Click to add points along the line. Double-click or press Enter to finish. Esc cancels.',
    }[mode]);
    if (hint) this.onHint?.(hint);
  }

  cancel(notify = true) {
    if (!this.mode) return;
    this.mode = null;
    this.pts = [];
    this.map.getSource('draw')?.setData(EMPTY);
    this.map.getCanvas().style.cursor = '';
    setTimeout(() => this.map.doubleClickZoom.enable(), 300);
    if (notify) this.onHint?.(null);
  }

  _ring() {
    const pts = this.cursor ? [...this.pts, this.cursor] : this.pts;
    if (this.mode === 'rect' && pts.length >= 2) {
      const [[x0, y0], [x1, y1]] = [pts[0], pts[pts.length - 1]];
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    }
    if (this.mode === 'circle' && pts.length >= 2) {
      const [c, edge] = [pts[0], pts[pts.length - 1]];
      return circleRing(c[0], c[1], this._radius(c, edge));
    }
    if (this.mode === 'polygon' && pts.length >= 3) return [...pts, pts[0]];
    return null;
  }

  _radius(c, edge) {
    const [x, y] = makeProjection(c[0], c[1]).toXY(edge[0], edge[1]);
    return Math.hypot(x, y);
  }

  _render() {
    const features = this.pts.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
    const ring = this._ring();
    if (ring) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
    else if (this.pts.length && this.cursor) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [...this.pts, this.cursor] } });
    }
    this.map.getSource('draw')?.setData({ type: 'FeatureCollection', features });
  }

  _click(e) {
    if (!this.mode) return;
    this.lastHandled = e.originalEvent;
    const p = [e.lngLat.lng, e.lngLat.lat];
    if (this.mode === 'polygon' && this.pts.length >= 3) {
      const first = this.map.project(this.pts[0]);
      if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 10) return this._finish();
    }
    if (this.pts.length) {
      // Ignore the second click of a double-click (same spot).
      const last = this.map.project(this.pts[this.pts.length - 1]);
      if (Math.hypot(last.x - e.point.x, last.y - e.point.y) < 4) return;
    }
    this.pts.push(p);
    if (this.mode === 'point') return this._finish();
    if ((this.mode === 'rect' || this.mode === 'circle') && this.pts.length === 2) return this._finish();
    this._render();
  }

  _dblclick(e) {
    if (this.mode !== 'polygon' && this.mode !== 'line') return;
    e.preventDefault();
    this.lastHandled = e.originalEvent;
    this._finish();
  }

  _key(e) {
    if (!this.mode) return;
    if (e.key === 'Escape') this.cancel();
    else if (e.key === 'Enter' && (this.mode === 'polygon' || this.mode === 'line')) this._finish();
    else if (e.key === 'Backspace' && this.pts.length) {
      this.pts.pop();
      this._render();
    }
  }

  _finish() {
    this.cursor = null;
    if (this.mode === 'point' || this.mode === 'line') {
      const mode = this.mode;
      const pts = this.pts.slice();
      if (mode === 'line' && pts.length < 2) return;
      this.cancel(false);
      this.onFinish(mode === 'point' ? { type: 'point', point: pts[0] } : { type: 'line', line: pts });
      return;
    }
    const ring = this._ring();
    if (!ring) return;
    const mode = this.mode;
    const shape = { type: mode, ring };
    if (mode === 'circle') {
      shape.center = this.pts[0];
      shape.radius = this._radius(this.pts[0], this.pts[1]);
    }
    this.cancel(false);
    this.onFinish(shape);
  }
}
