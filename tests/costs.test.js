// Building replacement costs: GEM lookup, JRC formula, construction types (js/costs.js),
// and how they enter the building value (js/risk.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gemCosts, jrcCosts, constructionType, ANCILLARY_SHARE } from '../js/costs.js';
import { unitValue, floodLoss } from '../js/risk.js';
import { near } from './helpers.js';

const gem = JSON.parse(readFileSync(new URL('../data/gem-costs.json', import.meta.url), 'utf8'));

test('GEM table: pinned source, all countries reachable by ISO alpha-2', () => {
  assert.equal(gem.gem_commit, 'c3add51f4e56f9d10477c8f6b5e24fd89fe089a1');
  assert.equal(gem.license, 'CC BY-NC-SA 4.0');
  assert.equal(Object.keys(gem.countries).length, 215);
  assert.equal(new Set(Object.values(gem.iso2)).size, 215);
});

test('GEM: regional values are used when the region is known', () => {
  const r = gemCosts(gem, 'pk', 'PK-GB'); // Gilgit-Baltistan
  assert.equal(r.level, 'region');
  assert.equal(r.region, 'Gilgit-Baltistan');
  assert.equal(r.costs.residential, Math.round(gem.countries.PAK.regions['PK-GB'].res[0]));
  assert.equal(r.costs.public, r.costs.commercial);
  assert.equal(r.costs.unknown, r.costs.residential);
  assert.equal(r.costs.ancillary, Math.round(gem.countries.PAK.regions['PK-GB'].res[0] * ANCILLARY_SHARE));
  const [cost, contents] = gem.countries.PAK.regions['PK-GB'].res;
  assert.equal(r.contentsPct.residential, Math.round((100 * contents) / cost));
});

test('GEM: national values when the region is missing or unknown', () => {
  const r = gemCosts(gem, 'PK', 'XX-YY');
  assert.equal(r.level, 'country');
  assert.equal(r.costs.residential, Math.round(gem.countries.PAK.res[0]));
  assert.equal(gemCosts(gem, 'ZZ', null), null);
});

test('GEM: costs differ widely between countries', () => {
  const pk = gemCosts(gem, 'PK').costs.residential;
  const gb = gemCosts(gem, 'GB').costs.residential;
  assert.ok(gb > 5 * pk, `UK ${gb} vs Pakistan ${pk}`);
});

test('GEM: construction-type factors are relative to the national average home', () => {
  const r = gemCosts(gem, 'PK');
  const t = gem.countries.PAK.types;
  near(r.typeFactors.earth, t.earth / gem.countries.PAK.res[0], 1e-3);
  assert.ok(r.typeFactors.earth < 1 && r.typeFactors.concrete > 1);
});

test('JRC formula at 2010 prices reproduces the report fit', () => {
  // Pakistan, GDP per capita 987 US$ (2010): residential 24.1 × 987^0.385 = 343 €/m² = 446 US$/m²
  const c = jrcCosts(987, 1);
  near(c.costs.residential, (24.1 * 987 ** 0.385) / 0.77, 0.5);
  near(c.costs.commercial, (33.6 * 987 ** 0.357) / 0.77, 0.5);
  near(c.costs.industrial, (30.8 * 987 ** 0.325) / 0.77, 0.5);
  assert.deepEqual([c.contentsPct.residential, c.contentsPct.commercial, c.contentsPct.industrial], [50, 100, 150]);
});

test('JRC formula: prices scale with inflation, real income drives the rest', () => {
  // Same real income at 1.5× the 2010 price level → costs 1.5× higher.
  const a = jrcCosts(1000, 1).costs.residential;
  const b = jrcCosts(1500, 1.5).costs.residential;
  near(b / a, 1.5, 0.01);
});

test('construction type from OSM building:material', () => {
  const cases = { mud: 'earth', adobe: 'earth', stone: 'earth', rammed_earth: 'earth', brick: 'masonry', cement_block: 'masonry',
    concrete_block: 'masonry', concrete: 'concrete', reinforced_concrete: 'concrete', steel: 'steel', metal: 'steel', wood: 'wood',
    timber_framing: 'wood', bamboo: 'wood', confined_masonry: 'reinforced_masonry', '': null, glass: null };
  for (const [m, t] of Object.entries(cases)) assert.equal(constructionType(m), t, m);
});

test('building value: per-class contents and construction-type factor', () => {
  const P = { costs: { residential: 200, commercial: 300 }, contentsPct: { residential: 20, commercial: 100 }, typeFactors: { earth: 0.8 } };
  near(unitValue({ cls: 'residential', ctype: null }, P), 240);
  near(unitValue({ cls: 'residential', ctype: 'earth' }, P), 192); // 200 × 0.8 × 1.2
  near(unitValue({ cls: 'commercial', ctype: 'earth' }, P), 600); // factor applies to homes only
  near(unitValue({ cls: 'residential', ctype: 'steel' }, P), 240); // no factor for this type
  // one contents % for all classes still works (older settings)
  near(unitValue({ cls: 'commercial' }, { costs: { commercial: 300 }, contentsPct: 50 }), 450);
  // loss uses the same value
  near(floodLoss({ cls: 'residential', ctype: 'earth', footprint: 100, floors: 1 }, 1, P), 192 * 100 * 0.49);
});
