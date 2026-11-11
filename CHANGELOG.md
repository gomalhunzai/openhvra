# Changelog

All notable changes to OpenHVRA are listed here. Versions follow [semantic versioning](https://semver.org):

- **0.x → 0.(x+1)**: a method changed, so results may differ from the previous version.
- **0.x.y → 0.x.(y+1)**: fixes and small additions; results unchanged.
- **1.0.0** will mark validated methods and the end of the beta.

Every exported map, chart, CSV and report states the version that produced it. The code for any version is on the [Releases page](https://github.com/gomalhunzai/openhvra/releases).

## [0.13.0] – 2026-11-11

With the same settings, results are identical to 0.12.3 unless buildings or facilities are added. The default building detail is now **Footprints**, so a run with the default settings uses exact building areas instead of estimated ones.

### Added
- **Building completeness check in step 1** ([#12](https://github.com/gomalhunzai/openhvra/issues/12), phase 1). After loading, the footprint area of the OSM buildings is compared with the GHSL built-up surface for 2020 (GHS-BUILT-S R2023A, 3 arc-seconds, © European Union, JRC, CC BY 4.0) in blocks of about 270 m. Step 1 reports the overall share and warns when it is under 80%. A new map layer shows the blocks where OSM has under 25%, 25–50%, 50–80% or 80% or more of the built-up area. The check is on by default and downloads only the parts of the global file covering the area (usually a few hundred kB, read straight from the AWS Open Data registry). The share, the rating and the block table are in `README.txt`, `parameters.csv`, `tables/osm_completeness_blocks.csv` and `layers/osm_completeness.geojson`.
- Checked on towns whose buildings are fully mapped in OSM from official registers: Amersfoort (Netherlands) 100%, Albi (France) 99%, Washington DC (United States) 104%, using footprints.
- **Filling gaps in buildings and critical facilities from Overture Maps** ([#12](https://github.com/gomalhunzai/openhvra/issues/12), phase 2). Everything still comes from OSM; other sources are used only for buildings and critical facilities, and only when OSM looks incomplete: under 10% → added automatically with a caution; 10–80% → offered with a button; 80% or more → nothing added. Added features are a separate green layer, included in every step (population is recalculated and steps 4–7 must be run again), marked in the exports and removable with one click.
  - **Buildings**: footprints detected from satellite imagery by Microsoft and Google (and Esri) from the Overture Maps buildings data (ODbL), read from Overture's public tile file (only the tiles covering the area). Any that overlaps or touches an OSM building is left out (OSM footprints in Footprints mode, bounding boxes in Light mode, 5 m around buildings mapped as points). `building_source` and `overture_id` in buildings.csv. Test in Karimabad (Hunza), Footprints mode: 1,152 added (Google 737, Microsoft 415), 33 left out as overlaps, share of the GHSL built-up area 69% → 98%. In Light mode the bounding boxes let no duplicates through but left out about 6% of the real gaps (199 of 3,443), so Footprints mode is recommended.
  - **Critical facilities**: places from the Overture Maps places data (CDLA Permissive 2.0; Foursquare records Apache 2.0), from 62 of Overture's categories mapped to the health, education, emergency, community, utilities, transport and hazardous groups. Places need a confidence of at least 0.6 and must not be marked closed; any within 100 m of an OSM facility of the same group, or with the same name, is left out as a duplicate. `facility_source`, `overture_id` and `overture_confidence` in facilities.csv.
- In **Light** mode, building areas come from bounding boxes, which overstate buildings not aligned north–south: in Hebden Bridge the share was about 1.5 times the footprint-based one (112% vs 76%). The app and the exports flag the Light-mode share as an upper bound.

### Changed
- **Footprints is now the default building detail** in step 1, so OSM buildings are drawn on the map as their real shapes, like the added buildings, instead of points. Light mode (about 3× smaller downloads, areas up to 60 km² instead of 25 km²) is still available and still shows buildings as points.
- **The Layers box no longer ticks layers that have no data yet.** Layers filled by a step (completeness, added buildings and facilities, exposure, flood depth, social vulnerability, glaciers and lakes, multi-hazard) start unticked and greyed out, tick themselves when their step runs, and untick again when their data is cleared.

## [0.12.3] – 2026-11-07

No method changes: results are identical to 0.12.2.

### Changed
- **The interface code is split into one file per step** ([#5](https://github.com/gomalhunzai/openhvra/issues/5)). `js/main.js` (2,089 lines) is now a short entry point, and each step's interface is in its own module in `js/ui/` (for example `area.js` for step 1 and `flood.js` for step 5), next to shared modules for state, formatting and the map. The code was moved, not rewritten. A full run of steps 1 to 8 on a test area produced an identical export package before and after (all 68 files, including maps and charts), and the interactive features (drawing, probe, layers, 3D, GLOF marks, exports, search) were checked for errors.

## [0.12.2] – 2026-11-07

No method changes: results are identical to 0.12.1.

### Fixed
- **Exported maps with wrong colours in some browsers.** In Firefox on Linux, the map image in the PNG layouts could come out with red and blue swapped (blue flood depths and waterways shown orange, orange roads shown blue), while the legend stayed correct. Spotted in the Hebden Bridge test export ([#1](https://github.com/gomalhunzai/openhvra/issues/1)). The map is now read from the graphics card in a fixed colour order, so exports look the same in every browser.

## [0.12.1] – 2026-11-07

No method changes: results are identical to 0.12.0.

### Changed
- **Licence changed from MIT to the GNU Affero General Public License v3.0** (AGPL-3.0-only). OpenHVRA stays free to use, copy, modify and share, including for commercial work, but anyone who shares a changed version, or runs one on a website or server for other people, must make its source code available under the same licence. Versions up to 0.12.0 remain available under MIT. Data licences (OpenStreetMap ODbL, GEM CC BY-NC-SA 4.0, Copernicus DEM) are unchanged.

## [0.12.0] – 2026-11-07

### Method change: elevation data (flood, exposure and multi-hazard results differ from 0.11.x)
- **Copernicus DEM GLO-30 is now the default elevation source** ([#9](https://github.com/gomalhunzai/openhvra/issues/9)). It is one consistent 30 m global model, read straight from its files on Microsoft Planetary Computer; only the parts covering the area are downloaded. Previously the AWS Terrain Tiles were used, which are SRTM (from 2000) in most of the world and national data in some countries.
- **Choose the elevation source in step 1**: Copernicus DEM GLO-30 or AWS Terrain Tiles. With Terrain Tiles, results are identical to 0.11.2.
- If Copernicus can't be downloaded, the app uses the Terrain Tiles automatically and says so.
- The search for the river bed next to each waterway and the slope calculation now use one data cell (about 30 m) on Copernicus, matching its native spacing. GLOF outflow tracing and lake elevations use Copernicus at about 60 m over the wider area around glacial lakes.
- Every export records the elevation source, grid spacing and files used (`parameters.csv`), and the credits include the Copernicus attribution.
- **Validation:** in a narrow, wooded valley town where the Terrain Tiles are built on national LiDAR, Copernicus found 71% of the buildings in the official 1-in-100-year flood zone at the default 3 m water level, against 90% with the Terrain Tiles. See [#9](https://github.com/gomalhunzai/openhvra/issues/9) and the README section *Elevation data*.

## [0.11.2] – 2026-11-05

No method changes: results are identical to 0.11.1.

### Changed
- **Faster, more reliable OpenStreetMap downloads.** Previously the app waited up to 120 seconds on an unresponsive Overpass server before trying the next, so a load could take about 3 minutes when a server was overloaded. Now each request starts on the server that has worked best recently (remembered in the browser), asks the next server as well if there is no answer within 30 seconds or straight away if one fails, and uses the first complete answer, cancelling the rest. When a server reports it is busy, the app reads when the next free slot is and waits that long before retrying. In tests on two 21 km² areas, loading took 38–39 s instead of 167–176 s.

## [0.11.1] – 2026-11-05

No method changes: results are identical to 0.11.0.

### Added
- **Source and year of the known population** in step 2 (census, WorldPop, GHSL, local survey or other), recorded in `parameters.csv`, the summary and the calibration note ([#8](https://github.com/gomalhunzai/openhvra/issues/8)).
- **"Where to find a population total"** guide in step 2: national census, WorldPop Global2 (2015–2030) and GHSL GHS-POP, with how to sum a gridded estimate inside the area in QGIS. An automatic WorldPop lookup was not added: WorldPop's statistics service only covers 2000–2020 and, like its newer files, cannot be read from a web page (no CORS).
- The full package now always includes `layers/area.geojson`; when the map view was used as the area, it is the view's rectangle.

## [0.11.0] – 2026-11-05

### Method change: building costs (flood losses differ from 0.10.x)
- **Building costs are now set for your area instead of one global placeholder** (previously 250 per m² for homes, labelled US dollars, with 30% contents, for every country). Including contents, that single value was about 3 times too high in some of the poorest countries (for example Afghanistan and Bhutan) and 7–10 times too low in Western Europe and North America. Choose the source in step 5:
  - **GEM Global Exposure Model 2026** (default): replacement cost per m² for the country and, where available, the province or state (215 countries, 3,557 regions), by residential, commercial and industrial use, with GEM's contents values. Homes with a mapped `building:material` are adjusted by GEM's cost for that construction type (earth/adobe/stone, brick or block, reinforced masonry, concrete, steel, wood). Data licence CC BY-NC-SA 4.0.
  - **JRC formula with the latest World Bank GDP per capita**: the JRC flood damage study's construction-cost regressions (Huizinga et al. 2017), applied to current GDP per capita and brought to current US dollars; contents 50/100/150% as in that study.
  - **Your own values**, in any currency.
- **Contents are set per building class** instead of one percentage.
- Every export records the cost source, region, construction-type factors and citation; `buildings.csv` adds each building's construction type.

## [0.10.2] – 2026-11-05

No method changes: results are identical to 0.10.1.

### Added
- **Automated tests** of the core calculations (`node --test`, nothing to install): damage curves, building loss, average annual loss, loss at any return period, risk-finance layers, multi-hazard index, combined risk, risk matrix, social vulnerability classes and geometry, checked against hand-worked values ([#2](https://github.com/gomalhunzai/openhvra/issues/2)).
- **Tests run automatically** on every push and pull request with GitHub Actions, with a syntax check of every script ([#3](https://github.com/gomalhunzai/openhvra/issues/3)).

### Changed
- **The Inter font and MapLibre 4.7.1 are now served from this site** instead of Google Fonts and jsDelivr: visitors' IP addresses are no longer sent to Google when the app opens, and the app no longer depends on an outside server to load. Files were checked against the npm registry's integrity hashes ([#4](https://github.com/gomalhunzai/openhvra/issues/4)).

## [0.10.1] – 2026-10-18

No method changes: results are identical to 0.10.0.

### Added
- **3D view** (button on the map): 3D terrain from the open elevation tiles with hillshade and an exaggeration slider (1–3×, true scale by default); buildings extruded to their real height (storeys × 3 m; Light-mode points as blocks sized from their estimated footprint), coloured by the active layer (multi-hazard/risk, social vulnerability, flood depth or exposure); all other layers drape over the terrain. Exported maps stay flat and north-up.

## [0.10.0] – 2026-10-18

### Method change: GLOF (results differ from 0.9.x)
- **Lakes now count only if their water can reach the area.** Each glacial lake's outflow is traced downstream: along OSM waterways (which are drawn in the direction of flow), joining at confluences and bridging gaps up to 60 m; by steepest descent on regional elevation where no stream is mapped; or along a path drawn by the user. Only lakes whose path passes through the analysed area are used. Previously any lake within 30 km and 100 m higher counted, which produced false positives from neighbouring valleys.
- **Homes are scored along the path, not by distance to the lake:** flood height (default 20 m at the lake, falling to 5 m at 30 km; both adjustable) minus the home's height above the path, within 600 m of the path.

### Added
- Glacier outlines, glacial lakes and traced outflow paths on the map (new "Glaciers, lakes & GLOF paths" layer), a lake table in step 7 (area, elevation, how the path was traced, whether it reaches the area) and lake tooltips.
- **Mark lake** (point or outline), **Mark glacier** (also searches OSM for lakes near it) and **Draw path** for any lake, with delete and download of your marks as GeoJSON.
- GLOF map export shows glaciers, lakes and paths; the ZIP adds `layers/glaciers.geojson`, `layers/glof_outflow_paths.geojson` and lake reach details.

## [0.9.1] – 2026-10-18

No method changes: results are identical to 0.9.0.

- Code released under the MIT License (`LICENSE`); license added to `CITATION.cff`, README and the welcome window.

## [0.9.0] – 2026-10-18

First numbered release (beta). It includes:

### Data and area
- OpenStreetMap download via Overpass (light or footprint mode), parallel requests, mirror fallback with back-off, 3-day browser cache.
- Area by rectangle, circle, polygon, current view or uploaded boundary (Shapefile, GeoJSON, TopoJSON, KML/KMZ, GPX, GeoPackage, WKT; reprojection; multi-part areas with holes).
- Facilities in 9 groups from many OSM tag families, including road bridges.

### Methods (as of this version)
- **Population**: residential floor area ÷ floor area per person, with optional census calibration.
- **Exposure by distance**: centre-to-line distance; for waterways, height above the channel (AWS Terrain Tiles), with flood-exposed / steep-bank (≥ 25°) / higher-ground split.
- **Flood risk**: depth = scenario water level − height above nearest river; JRC Asia depth-damage curves; losses for flooded floors only (3 m per storey); average annual loss by trapezoidal integration; risk-finance layering.
- **Social vulnerability**: SVI from access to health care, emergency services and roads, housing fragility and crowding, plus an optional census layer; relative (fifths) or absolute classes; vulnerable groups from World Bank shares.
- **Multi-hazard**: river and flash flood, landslide, earthquake (USGS catalogue × building vulnerability), coastal flood, GLOF and avalanche scores; index 1 − Π(1 − w·s′) with a 0.2 background floor; combined risk √(hazard × vulnerability); likelihood × impact risk matrix with full calculation.

### Outputs
- Per-step CSV/GeoJSON downloads; full ZIP package with summary, parameters, per-step tables, combined tables and GeoJSON layers.
- Publication map layouts (A4 landscape, 300 DPI) and charts (SVG + 300-DPI PNG) for every step, also included in the ZIP.
- Version number shown in the app and stamped on every export; `CITATION.cff` for citing the software.

[0.10.1]: https://github.com/gomalhunzai/openhvra/releases/tag/v0.10.1
[0.10.0]: https://github.com/gomalhunzai/openhvra/releases/tag/v0.10.0
[0.9.1]: https://github.com/gomalhunzai/openhvra/releases/tag/v0.9.1
[0.9.0]: https://github.com/gomalhunzai/openhvra/releases/tag/v0.9.0
