// Geometry helpers (js/spatial.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ringArea, pointInRing, bboxAreaKm2, makeProjection, nearestOnSeg } from '../js/spatial.js';
import { near } from './helpers.js';

const rect = [[0, 0], [100, 0], [100, 50], [0, 50]];

test('ring area (shoelace)', () => {
  near(ringArea(rect), 5000);
});

test('point in ring', () => {
  assert.equal(pointInRing(50, 25, rect), true);
  assert.equal(pointInRing(150, 25, rect), false);
});

test('area of a 1-degree box at the equator', () => {
  near(bboxAreaKm2([0, 0, 1, 1]), 12308, 1);
});

test('projection: round trip and scale', () => {
  const p = makeProjection(74.6, 36.3);
  const [x, y] = p.toXY(74.61, 36.31);
  const [lon, lat] = p.toLonLat(x, y);
  near(lon, 74.61, 1e-9);
  near(lat, 36.31, 1e-9);
  near(y, 1105.74, 0.01); // 0.01 degree of latitude is about 1.1 km
});

test('nearest point on a segment', () => {
  const mid = nearestOnSeg(50, 10, 0, 0, 100, 0); // above the middle
  near(mid.d, 10);
  near(mid.x, 50);
  const end = nearestOnSeg(-30, 40, 0, 0, 100, 0); // beyond the start: clamps to the end point
  near(end.d, 50);
  near(end.x, 0);
});
