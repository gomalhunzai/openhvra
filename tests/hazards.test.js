// Multi-hazard index, combined risk and the likelihood × impact matrix (js/hazards.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combine, riskMatrix, rating } from '../js/hazards.js';
import { near } from './helpers.js';

// One point with the given hazard scores, vulnerability 0.75.
const run = (hz, weights = { a: 1, b: 1 }) => {
  const p = { hz };
  combine({ points: [p] }, weights, {}, () => 0.75);
  return p;
};

test('multi-hazard index: one severe hazard stays severe', () => {
  const p = run({ a: 1 });
  near(p.mhi, 1);
  near(p.risk, Math.sqrt(0.75)); // 0.866
  assert.equal(p.highHazards, 1);
});

test('multi-hazard index: two moderate hazards add up', () => {
  const p = run({ a: 0.6, b: 0.6 });
  near(p.mhi, 0.75);
  near(p.risk, 0.75);
  assert.equal(p.highHazards, 2);
});

test('multi-hazard index: background scores at or below 0.2 do not count', () => {
  const p = run({ a: 0.2, b: 0.1 });
  near(p.mhi, 0);
  near(p.risk, 0);
  assert.equal(p.highHazards, 0);
});

test('multi-hazard index: no scores gives no result', () => {
  const p = run(undefined);
  assert.equal(p.mhi, null);
  assert.equal(p.risk, null);
  assert.equal(p.highHazards, 0);
});

test('multi-hazard index: weights scale a hazard', () => {
  near(run({ a: 0.6 }, { a: 0.5 }).mhi, 0.25);
});

test('multi-hazard index: hazards with a note (not assessed) are left out', () => {
  const p = { hz: { a: 1, b: 1 } };
  const keys = combine({ points: [p] }, { a: 1, b: 1 }, { b: 'no data' });
  assert.deepEqual(keys, ['a']);
  assert.equal(p.risk, null); // no vulnerability function given
});

test('risk matrix: one home of ten at high hazard, plus a health facility', () => {
  const buildings = Array.from({ length: 10 }, (_, i) => ({ pop: 10, hz: { a: i === 0 ? 0.9 : 0.1 } }));
  const facilities = [{ group: 'health', hz: { a: 0.9 } }];
  const [m] = riskMatrix({ buildings, facilities }, ['a']);
  near(m.p90, 0.1);
  assert.equal(m.likelihood, 1);
  near(m.exposedShare, 0.1);
  assert.equal(m.impactBase, 4);
  assert.equal(m.impact, 5);
  assert.equal(m.score, 5);
  assert.equal(m.rating, 'Medium');
});

test('risk matrix: no homes', () => {
  const [m] = riskMatrix({ buildings: [], facilities: [] }, ['a']);
  assert.equal(m.likelihood, 1);
  assert.equal(m.impact, 1);
  assert.equal(m.rating, 'Low');
});

test('rating thresholds', () => {
  assert.equal(rating(4), 'Low');
  assert.equal(rating(5), 'Medium');
  assert.equal(rating(9), 'Medium');
  assert.equal(rating(10), 'High');
  assert.equal(rating(16), 'High');
  assert.equal(rating(17), 'Extreme');
});
