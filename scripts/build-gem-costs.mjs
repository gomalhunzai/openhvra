// Builds data/gem-costs.json: building replacement costs per m² by country,
// admin-1 region and residential construction type, from the GEM Global
// Exposure Model v2026.0.0 as compiled by the UCC Database.
//
//   node scripts/build-gem-costs.mjs
//
// Sources are pinned to exact commits so the output can be reproduced.
// Data licence: CC BY-NC-SA 4.0 (GEM). The output keeps that licence.
import { writeFileSync } from 'node:fs';

const UCC = 'https://raw.githubusercontent.com/aaronopdyke/ucc-database/d366078786b5783138886face499963153725340/data';
const GEM_COMMIT = 'c3add51f4e56f9d10477c8f6b5e24fd89fe089a1'; // tag v2026.0.0
const OUT = new URL('../data/gem-costs.json', import.meta.url);

async function csv(name) {
  const res = await fetch(`${UCC}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const [head, ...lines] = (await res.text()).trim().split(/\r?\n/);
  const cols = head.split(',');
  // Names may contain commas inside quotes.
  const split = (l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).slice(0, cols.length).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
  return lines.map((l) => Object.fromEntries(split(l).map((v, i) => [cols[i], v])));
}

const r1 = (v) => Math.round(+v * 10) / 10;
const OCC = { RES: 'res', COM: 'com', IND: 'ind' };
// Store [replacement cost per m², contents per m²] in USD.
const pair = (r) => [r1(r.UCC_USD_PER_SQM), r1(r.CONTENTS_USD_PER_SQM)];

const [adm0, adm1, tax] = await Promise.all([csv('ucc_adm0.csv'), csv('ucc_adm1.csv'), csv('ucc_taxonomy.csv')]);
for (const r of adm0) if (r.GEM_COMMIT && !GEM_COMMIT.startsWith(r.GEM_COMMIT)) throw new Error(`unexpected GEM commit ${r.GEM_COMMIT}`);

const countries = {};
for (const r of adm0) {
  const c = (countries[r.ID_0] ??= { name: r.NAME_0, regions: {} });
  if (OCC[r.OCCUPANCY]) c[OCC[r.OCCUPANCY]] = pair(r);
}
for (const r of adm1) {
  const c = countries[r.ID_0];
  if (!c || !OCC[r.OCCUPANCY] || !r.ID_1) continue;
  const g = (c.regions[r.ID_1] ??= { name: r.NAME_1 });
  g[OCC[r.OCCUPANCY]] = pair(r);
}
// Residential cost per m² by construction type (area-weighted over urban and
// rural settlements and all heights). GEM macro types are grouped as:
// earth = adobe, stone and earthen; masonry = unreinforced; reinforced_masonry =
// reinforced or confined; concrete = reinforced concrete (ductile or not);
// steel; wood. Hybrid and other types are left out.
const TYPE = { 'ADO|ST|E': 'earth', MUR: 'masonry', 'MR|MCF': 'reinforced_masonry', 'CR-': 'concrete', 'CR+': 'concrete', S: 'steel', W: 'wood' };
const acc = {};
for (const r of tax) {
  if (r.OCCUPANCY !== 'RES' || !countries[r.ID_0] || !TYPE[r.MACRO_TAXONOMY]) continue;
  const k = `${r.ID_0}\t${TYPE[r.MACRO_TAXONOMY]}`;
  const a = (acc[k] ??= { cost: 0, area: 0 });
  a.cost += +r.BLDG_REPL_COST_USD;
  a.area += +r.TOTAL_AREA_SQM;
}
for (const [k, a] of Object.entries(acc)) {
  const [iso3, macro] = k.split('	');
  if (a.area > 0) (countries[iso3].types ??= {})[macro] = r1(a.cost / a.area);
}

// ISO 3166 alpha-2 → alpha-3, so a reverse-geocoded country code can be looked up.
const wb = await (await fetch('https://api.worldbank.org/v2/country?format=json&per_page=400')).json();
const iso2 = {};
for (const c of wb[1]) if (countries[c.id] && /^[A-Z]{2}$/.test(c.iso2Code)) iso2[c.iso2Code] = c.id;
// Countries and territories the World Bank list leaves out: take the alpha-2
// prefix of their admin-1 codes (for example TW-TPE → TW).
for (const [iso3, c] of Object.entries(countries)) {
  if (Object.values(iso2).includes(iso3)) continue;
  const pre = Object.keys(c.regions).map((id) => id.split('-')[0]).find((p) => /^[A-Z]{2}$/.test(p));
  if (pre && !iso2[pre]) iso2[pre] = iso3;
}
const missing = Object.keys(countries).filter((k) => !Object.values(iso2).includes(k));

const out = {
  source: 'GEM Global Exposure Model v2026.0.0',
  gem_commit: GEM_COMMIT,
  compiled_by: 'UCC Database (A. Opdyke), commit d366078',
  units: 'USD per m² of floor area; [replacement cost of structural and non-structural components, contents]',
  license: 'CC BY-NC-SA 4.0',
  citation: 'Yepes-Estrada, C., Calderon, A., Costa, C., Crowley, H., Dabbeek, J., Hoyos, M.C., Martins, L., Paul, N., Rao, A., Silva, V. (2023). Global Building Exposure Model for Earthquake Risk Assessment. Earthquake Spectra, 39(4). doi:10.1177/87552930231194048',
  iso2,
  countries,
};
writeFileSync(OUT, JSON.stringify(out));
console.log(`${Object.keys(countries).length} countries, ${Object.values(countries).reduce((a, c) => a + Object.keys(c.regions).length, 0)} regions, ${Object.keys(iso2).length} ISO2 codes; no ISO2 for: ${missing.join(' ') || 'none'}`);
