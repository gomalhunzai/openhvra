// Building replacement costs for the flood loss model (step 5).
//
// Two sources, chosen by the user:
//   gem  GEM Global Exposure Model v2026.0.0 (Yepes-Estrada et al. 2023):
//        modelled replacement cost per m² of floor area for each country and
//        admin-1 region, by occupancy, plus contents and residential cost by
//        construction type. Data licence CC BY-NC-SA 4.0.
//   jrc  The JRC global construction-cost regressions (Huizinga et al. 2017,
//        Table 3-25): cost = a × (GDP per capita)^b, fitted in 2010 euros and
//        2010 US$. Applied here to the latest World Bank GDP per capita,
//        converted to 2010 prices and back with the US consumer price index.
// Both give undepreciated replacement costs in US dollars.

export const COST_SOURCES = {
  gem: 'GEM Global Exposure Model 2026 (by country and region)',
  jrc: 'JRC formula with latest World Bank GDP per capita',
  own: 'My own values',
};

export const GEM_CITATION = 'Yepes-Estrada, C. et al. (2023). Global Building Exposure Model for Earthquake Risk Assessment. Earthquake Spectra, 39(4). doi:10.1177/87552930231194048. Data: GEM Global Exposure Model v2026.0.0, CC BY-NC-SA 4.0.';
export const JRC_CITATION = 'Huizinga, J., de Moel, H., Szewczyk, W. (2017). Global flood depth-damage functions: Methodology and the database with guidelines. JRC105688, EUR 28552 EN. doi:10.2760/16510. GDP per capita and CPI: World Bank WDI.';

// Sheds, garages and other ancillary buildings have no class in either
// source: they are costed at this share of the residential value.
export const ANCILLARY_SHARE = 0.4;

// ---- GEM ------------------------------------------------------------------------

let gemData = null;
export async function loadGem() {
  if (!gemData) {
    const res = await fetch(new URL('../data/gem-costs.json', import.meta.url));
    if (!res.ok) throw new Error(`cost table could not be loaded (HTTP ${res.status})`);
    gemData = await res.json();
  }
  return gemData;
}

// Residential construction types, from OSM building:material (or
// building:structure / building:walls). Grouped like the GEM macro types.
export const CONSTRUCTION_TYPES = {
  earth: 'Earth, adobe or stone',
  masonry: 'Brick or block masonry',
  reinforced_masonry: 'Reinforced or confined masonry',
  concrete: 'Reinforced concrete',
  steel: 'Steel or metal',
  wood: 'Wood or bamboo',
};

export function constructionType(material) {
  const m = String(material ?? '').toLowerCase();
  if (!m) return null;
  if (/reinforced_masonry|confined/.test(m)) return 'reinforced_masonry';
  if (/mud|adobe|earth|rammed|cob|clay|stone|rubble/.test(m)) return 'earth';
  if (/brick|masonry|block|unreinforced/.test(m)) return 'masonry'; // incl. concrete_block, cement_block
  if (/concrete|reinforced|cement/.test(m)) return 'concrete';
  if (/steel|metal|iron/.test(m)) return 'steel';
  if (/wood|timber|bamboo|log/.test(m)) return 'wood';
  return null;
}

const round = (v) => Math.round(v);
const pct = (pair) => (pair && pair[0] > 0 ? round((100 * pair[1]) / pair[0]) : 0);

// Costs per building class for a country (ISO 3166 alpha-2) and, when the
// region code (ISO 3166-2, e.g. PK-GB) is in GEM, that region.
export function gemCosts(data, iso2, regionCode) {
  const iso3 = data.iso2[String(iso2 ?? '').toUpperCase()];
  const c = iso3 && data.countries[iso3];
  if (!c) return null;
  const g = regionCode ? c.regions[regionCode] : null;
  const pick = (k) => g?.[k] ?? c[k] ?? c.res;
  const res = pick('res');
  const com = pick('com');
  const ind = pick('ind');
  // Construction-type costs are national; apply them relative to the national residential average.
  const typeFactors = Object.fromEntries(Object.entries(c.types ?? {}).map(([k, v]) => [k, Math.round((1000 * v) / c.res[0]) / 1000]));
  return {
    source: 'gem',
    iso3,
    country: c.name,
    region: g?.name ?? null,
    level: g ? 'region' : 'country',
    costs: {
      residential: round(res[0]), commercial: round(com[0]), industrial: round(ind[0]),
      public: round(com[0]), ancillary: round(res[0] * ANCILLARY_SHARE), unknown: round(res[0]),
    },
    contentsPct: {
      residential: pct(res), commercial: pct(com), industrial: pct(ind),
      public: pct(com), ancillary: pct(res), unknown: pct(res),
    },
    typeFactors,
    currency: 'USD',
    citation: GEM_CITATION,
  };
}

// ---- JRC + World Bank ----------------------------------------------------------------

// Power-law fits y = a·x^b, y = construction cost in €/m² (2010), x = GDP per
// capita in US$ (2010). Huizinga et al. (2017), Table 3-25.
export const JRC_FIT = { residential: [24.1, 0.385], commercial: [33.6, 0.357], industrial: [30.8, 0.325] };
// Contents as % of building damage (Table 3-26).
export const JRC_CONTENTS = { residential: 50, commercial: 100, industrial: 150 };
// Exchange rate used in the report (Table 2-2): 1 US$ = 0.77 € (2010 mean).
export const EUR_PER_USD_2010 = 0.77;

// gdpPc: GDP per capita in current US$ of year Y; priceRatio: US CPI(Y) / CPI(2010).
export function jrcCosts(gdpPc, priceRatio) {
  const x = gdpPc / priceRatio; // in 2010 US$
  const cost = (k) => round(((JRC_FIT[k][0] * x ** JRC_FIT[k][1]) / EUR_PER_USD_2010) * priceRatio);
  const res = cost('residential');
  const com = cost('commercial');
  return {
    costs: { residential: res, commercial: com, industrial: cost('industrial'), public: com, ancillary: round(res * ANCILLARY_SHARE), unknown: res },
    contentsPct: {
      residential: JRC_CONTENTS.residential, commercial: JRC_CONTENTS.commercial, industrial: JRC_CONTENTS.industrial,
      public: JRC_CONTENTS.commercial, ancillary: JRC_CONTENTS.residential, unknown: JRC_CONTENTS.residential,
    },
  };
}

const WB = 'https://api.worldbank.org/v2/country';
async function wbLatest(country, indicator, signal, date = null) {
  const q = date ? `date=${date}` : 'mrnev=1';
  const res = await fetch(`${WB}/${country}/indicator/${indicator}?format=json&${q}`, { signal });
  const row = (await res.json())[1]?.[0];
  if (row?.value == null) throw new Error(`no World Bank value for ${indicator}`);
  return { value: row.value, year: +row.date, country: row.country?.value };
}

// US consumer price index from 2010 to `year`; the latest year with a value
// is used when `year` itself is not published yet.
async function usPrices(year, signal) {
  const res = await fetch(`${WB}/US/indicator/FP.CPI.TOTL?format=json&date=2010:${year}&per_page=100`, { signal });
  const rows = ((await res.json())[1] ?? []).filter((r) => r.value != null);
  const base = rows.find((r) => +r.date === 2010);
  const last = rows.reduce((a, r) => (!a || +r.date > +a.date ? r : a), null);
  if (!base || !last) throw new Error('no World Bank price index for the United States');
  return { ratio: last.value / base.value, year: +last.date };
}

export async function fetchJrcCosts(iso2, signal) {
  const gdp = await wbLatest(iso2, 'NY.GDP.PCAP.CD', signal);
  const prices = await usPrices(gdp.year, signal);
  const ratio = prices.ratio;
  return {
    source: 'jrc',
    country: gdp.country,
    region: null,
    level: 'country',
    ...jrcCosts(gdp.value, ratio),
    typeFactors: {},
    currency: 'USD',
    year: gdp.year,
    gdpPc: gdp.value,
    priceRatio: ratio,
    priceYear: prices.year,
    citation: JRC_CITATION,
  };
}

// ---- Location ---------------------------------------------------------------------------

// Country (ISO 3166 alpha-2) and first-level region (ISO 3166-2) of a point.
export async function locate(lon, lat, signal) {
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=5&accept-language=en&lat=${lat}&lon=${lon}`, { signal });
  if (!res.ok) throw new Error(`place lookup failed (HTTP ${res.status})`);
  const a = (await res.json()).address ?? {};
  if (!a.country_code) throw new Error('could not identify the country for this area');
  return { iso2: a.country_code.toUpperCase(), country: a.country, regionCode: a['ISO3166-2-lvl4'] ?? null, region: a.state ?? a.province ?? a.region ?? null };
}

// Look up costs for a point with the chosen source.
export async function costsFor(source, lon, lat, signal) {
  const loc = await locate(lon, lat, signal);
  if (source === 'jrc') return fetchJrcCosts(loc.iso2, signal);
  const r = gemCosts(await loadGem(), loc.iso2, loc.regionCode);
  if (!r) throw new Error(`${loc.country} is not in the GEM cost table`);
  return r;
}
