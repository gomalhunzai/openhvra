// Flood damage, loss and risk-finance calculations (js/risk.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAMAGE_CURVES, DEFAULT_COSTS, DEFAULT_FINANCE, damageFraction, floodLoss, expectedAnnual, lossAtRP, financeLayers } from '../js/risk.js';
import { near } from './helpers.js';

test('damage curve: no water, no damage', () => {
  assert.equal(damageFraction(DAMAGE_CURVES.residential, 0), 0);
  assert.equal(damageFraction(DAMAGE_CURVES.residential, -1), 0);
});

test('damage curve: interpolates between points', () => {
  // halfway between 0.33 (0.5 m) and 0.49 (1 m)
  near(damageFraction(DAMAGE_CURVES.residential, 0.75), 0.41);
});

test('damage curve: exact point and beyond the curve', () => {
  near(damageFraction(DAMAGE_CURVES.residential, 1), 0.49);
  assert.equal(damageFraction(DAMAGE_CURVES.residential, 10), 1);
});

test('building loss: ground floor only, then two floors', () => {
  const p = { cls: 'residential', footprint: 100, floors: 2 };
  const P = { costs: DEFAULT_COSTS, contentsPct: 50 };
  near(floodLoss(p, 1, P), 18375); // 250 × 100 m² × 1 floor × 1.5 × 0.49
  near(floodLoss(p, 3.5, P), 67500); // water reaches floor 2: 250 × 100 × 2 × 1.5 × 0.90
});

test('average annual loss', () => {
  // (1/10 − 1/100) × 550, plus 1,000/100 for rarer events
  near(expectedAnnual([{ rp: 10, v: 100 }, { rp: 100, v: 1000 }]), 59.5);
  near(expectedAnnual([{ rp: 100, v: 500 }]), 5);
  assert.equal(expectedAnnual([]), 0);
});

test('loss at any return period (log interpolation)', () => {
  const curve = [{ rp: 10, loss: 100 }, { rp: 100, loss: 1000 }];
  assert.equal(lossAtRP(curve, 1), 0);
  near(lossAtRP(curve, 5), 69.897, 1e-3); // 100 × ln 5 / ln 10
  near(lossAtRP(curve, 10), 100);
  near(lossAtRP(curve, Math.sqrt(1000)), 550); // halfway on the log scale
  assert.equal(lossAtRP(curve, 1000), 1000); // beyond the curve: last value
  assert.equal(lossAtRP([], 50), 0);
});

test('risk-finance layers add up to the total expected annual loss', () => {
  const rps = [5, 10, 25, 50, 100, 500];
  const losses = [10, 50, 200, 400, 700, 1500];
  const curve = rps.map((rp, i) => ({ rp, loss: losses[i] }));
  const total = expectedAnnual(curve.map((c) => ({ rp: c.rp, v: c.loss })));
  const layers = financeLayers(curve, DEFAULT_FINANCE);
  near(total, 33.8);
  near(layers.reduce((a, l) => a + l.eal, 0), total);
  for (let i = 1; i < layers.length; i++) assert.equal(layers[i].from, layers[i - 1].to, 'layers stack without gaps');
});
