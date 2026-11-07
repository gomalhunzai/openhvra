# Data

## gem-costs.json

Building replacement costs per m² of floor area (US dollars) for 215 countries and 3,557 first-level regions, by occupancy (residential, commercial, industrial) with contents, and residential cost by construction type. Used as the default building costs in step 5.

- **Source:** GEM Global Exposure Model v2026.0.0 (commit `c3add51`), compiled by the UCC Database (commit `d366078`).
- **Rebuild:** `node scripts/build-gem-costs.mjs` (sources are pinned, so the output is reproducible).
- **Licence:** [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), the licence of the GEM source data. This file is **not** covered by the AGPL-3.0 licence of the OpenHVRA code. You may use and share it for non-commercial purposes, with credit, under the same licence.
- **Cite:** Yepes-Estrada, C., Calderon, A., Costa, C., Crowley, H., Dabbeek, J., Hoyos, M.C., Martins, L., Paul, N., Rao, A., Silva, V. (2023). Global Building Exposure Model for Earthquake Risk Assessment. *Earthquake Spectra*, 39(4). https://doi.org/10.1177/87552930231194048

Format: `countries[ISO3] = { name, res, com, ind, regions: { ISO 3166-2 code: { name, res, com, ind } }, types: { construction type: residential cost } }`, where each `res`/`com`/`ind` is `[replacement cost, contents]` per m². `iso2` maps ISO 3166 alpha-2 codes to the ISO3 keys.
