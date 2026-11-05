// Shared test helper: compare decimals with a small tolerance
// (for example 0.33 + 0.5 × 0.16 is 0.41000000000000003).
import assert from 'node:assert/strict';

export function near(actual, expected, tol = 1e-6, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, msg ?? `expected ${expected}, got ${actual}`);
}
