// Social vulnerability classes and vulnerable group counts (js/social.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sviClass, groupCounts, DEFAULT_SHARES } from '../js/social.js';
import { near } from './helpers.js';

test('SVI classes', () => {
  assert.equal(sviClass(0), 0);
  assert.equal(sviClass(0.19), 0);
  assert.equal(sviClass(0.2), 1);
  assert.equal(sviClass(0.8), 4);
  assert.equal(sviClass(1), 4);
});

test('vulnerable group counts from shares', () => {
  const g = groupCounts(1000, DEFAULT_SHARES);
  near(g.children, 250);
  near(g.elderly, 70);
  near(g.disability, 160);
  near(g.poverty, 100);
});
