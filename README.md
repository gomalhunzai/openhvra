<p align="center"><img src="assets/logo.jpg" alt="OpenHVRA: Hazard, Vulnerability &amp; Risk Assessment from Open Data" width="480"></p>

# OpenHVRA

*Hazard, Vulnerability & Risk Assessment from open data*

**Live app: https://gomalhunzai.github.io/openhvra/**

Created and maintained by [Gomal Amin](https://www.openstreetmap.org/user/Gomal%20Amin) (OpenStreetMap profile).

**Current version: 0.10.1 (beta)**. See the [CHANGELOG](CHANGELOG.md) for what changed in each version.

A free web map for disaster risk practitioners. It shows how many people, buildings and critical facilities lie near rivers, streams and roads, and estimates what floods could cost and how to finance them. Everything comes from open data: OpenStreetMap and open elevation tiles.

## What it does

1. **Area & data**
   - Choose an area by drawing a **rectangle**, **circle** or **polygon** (with the buttons in the panel or the toolbar at the map's top-left), or use the current view.
   - Or **upload a boundary file**, or drag and drop one onto the map. Supported formats:
     - Shapefile, as a `.zip` or as `.shp` + `.dbf` + `.prj` selected together
     - GeoJSON and TopoJSON
     - KML and KMZ
     - GPX
     - GeoPackage (`.gpkg`)
     - WKT

     Files in Web Mercator or UTM, and shapefiles or GeoPackages with their coordinate system defined, are converted to longitude/latitude automatically.
   - If a file contains several areas (for example all wards of a district), pick one from the list or use them all. Multi-part areas and holes are supported, and very detailed boundaries are simplified automatically. A file with no polygons (points or a GPX track) uses its bounding box.
   - The libraries that read these formats only download the first time you upload that type of file.
   - Pick which layers to download. **Light** mode (the default) downloads building bounding boxes instead of full footprints, which is about 3× smaller, and estimates each building's area from its box. Facilities are downloaded as centre points only.
   - Buildings and the remaining layers download in parallel, falling back across public Overpass servers. Downloads are cached in the browser for 3 days, so reloading the same area is instant.
2. **Population model**: estimates residents per building as residential floor area (footprint × storeys) ÷ floor area per person. Enter a census total to calibrate. Buildings are split into residential, commercial, industrial, public and ancillary classes.
3. **Cursor probe**: a circle (25–1000 m) follows the mouse and shows live counts of residents, buildings and facilities, road and waterway length, and the distance to the nearest waterway and major road.
4. **Exposure by distance**: counts and maps everything within *X* m of rivers, streams or roads, and lists the critical facilities at risk. For waterways, **elevation is used** (on by default): a building only counts as flood-exposed if it is also within a set height of the channel (default 5 m). Close-but-high buildings are split into **steep bank** (25° or steeper down to the water, so at risk of erosion or undercutting) and **higher ground** (not exposed). This avoids counting hillside homes in mountain valleys as flood-exposed.
5. **Flood risk & risk finance**
   - **Hazard**: estimates flood depth at each building from its *height above the nearest waterway*, using open elevation data. You enter the water level for each return period, for example the 5-, 10-, 25-, 50-, 100- and 500-year floods.
   - **Vulnerability**: depth-damage curves for residential, commercial and industrial buildings (approximately the JRC global curves for Asia, Huizinga et al. 2017), applied to replacement cost per m² plus contents.
   - **Risk metrics**: for each scenario, the loss, people affected and critical facilities flooded. Also a **loss-exceedance curve**, the **average annual loss (AAL)**, the expected number of people affected per year, and a landslide screen based on slope.
   - **Risk finance**: splits the loss curve into layers: *retain* (reserve fund), *borrow* (contingent credit), *transfer* (parametric insurance or cat bond) and *residual*. Each layer shows its expected annual loss and an indicative annual cost.
6. **Social vulnerability**
   - **Social Vulnerability Index (SVI)**: each home gets a score from 0 (least) to 1 (most vulnerable), the average of these indicators:
     - distance to the nearest health facility
     - distance to emergency services or a shelter
     - distance to a road
     - housing fragility (huts, sheds, tents, containers, small single-storey homes)
     - crowding (residents per hectare)
     - optionally, your own **census layer**: upload ward or district polygons with a numeric field such as the poverty rate, and it is joined to every home inside them

     Homes are shown on the map in five classes, from very low to very high.
   - **Vulnerable groups**: children (0–14), elderly (65+), people with disabilities and people in extreme poverty. Their shares can be filled in automatically with national figures from the **World Bank** (disability uses the WHO global estimate of 16%), or entered by hand.
   - **Combined with the flood analysis**: residents flooded in each vulnerability class, the number of highly vulnerable residents flooded (for prioritisation), and the vulnerable groups in the flood zone.
   - **CSV and GeoJSON downloads**, one row per home: score, class and rank, each indicator, census value, distances to health and emergency services, estimated children, elderly people, people with disabilities and people in poverty, and flood depth (if step 5 has run).
7. **Multi-hazard risk**: every building gets a 0–1 score for each hazard:

   | Hazard | How it is scored |
   |---|---|
   | River flood | Depth at the 100-year water level from step 5, using height above the nearest river |
   | Flash / rain flood | Terrain hollows, flat ground, and nearby streams or drains |
   | Landslide | Steepest slope nearby, local relief, and undercutting by streams or road cuts |
   | Earthquake | Regional seismicity from the **USGS catalogue** (M5+ frequency since 1973, largest event within 100 km) × building vulnerability (material, storeys, fragile building types, steep or soft riverside ground). No shaking scenario is needed. |
   | Coastal flood | Ground below a chosen sea level plus surge, within 10 km of the coast |
   | Glacial lake outburst (GLOF) | Each glacial lake's outflow is **traced downstream** (along OSM streams, or the terrain where none is mapped, or a path you draw). Only lakes whose path passes through your area count. Homes are scored by their height above the path against a flood height that falls downstream (default 20 m at the lake to 5 m at 30 km). Lakes come from OSM (near glaciers), uploaded inventories, or lakes and glaciers you **mark on the map**; glaciers, lakes and paths are shown so you can check them. |
   | Snow avalanche | Steep (28–55°) slopes above a chosen snow line, using the alpha-angle runout rule |

   The scores combine into a **multi-hazard index** (1 − Π(1 − weight × score)), so one severe hazard stays severe and several moderate ones add up. Together with social vulnerability, this gives a **combined risk** score (√(hazard × vulnerability), as in INFORM).

   Results include a **likelihood × impact risk matrix** with its full calculation shown (90th-percentile score → likelihood; share of residents at high hazard → impact, +1 if a critical facility is exposed; L × I → rating), homes and residents facing two or more high hazards, critical facilities exposed, maps for each hazard and for combined risk, and CSV/GeoJSON exports. Hazards that don't apply (no coast, no glaciers, no terrain above the snow line) are reported and left out.
8. **Report & downloads**: one click downloads a ZIP package containing:
   - `README.txt`: a readable summary of every setting and result, step by step, including the risk-matrix working
   - `steps/`: a detailed table for **each step you ran** (population, exposure, flood risk, social vulnerability, multi-hazard), covering the features that step assessed and its values
   - `parameters.csv`: every selected setting
   - `buildings.csv` and `facilities.csv`: one row per feature with all its analysis values (population, distance and height above water, flood depth and loss per scenario, average annual loss, social vulnerability and its indicators, every hazard score, the multi-hazard index and combined risk)
   - `tables/`: population, exposure, flood scenarios, finance layers, vulnerability classes, vulnerable groups, hazard summary, **risk-matrix calculation** and earthquakes
   - `layers/`: area, buildings, facilities, roads, waterways and glacial lakes as GeoJSON, with the same values
   - `charts/`: every chart as **SVG** (vector, editable, journal-ready) and **PNG at 300 DPI**
   - `maps/`: publication **map layouts** (A4 landscape, 300 DPI) for each step, including one per hazard

   Every step also has its own **Map (PNG, 300 DPI)** button and a **Charts** list with SVG/PNG downloads. Map layouts include a title, area and date, legend, key figures, scale bar, north arrow, data credits and the OpenHVRA version.

   The checklist in step 8 has a **CSV button for each completed step**, and buildings, facilities and the risk matrix can also be downloaded as separate CSVs. Each step still has its own quick CSV/GeoJSON exports.

**Facility categories** come from several OSM tag families, not just `amenity`. They include `healthcare`, `emergency`, `office=government`, `shop`, `tourism`, `historic`/`heritage`, `power`, `man_made`, `telecom`, `railway`, `aeroway` and `leisure`, plus road bridges. These are grouped as follows:

- health
- education
- emergency services & shelter
- government, community & heritage
- water, power & telecom
- transport hubs & bridges
- markets, shops & finance
- hazardous sites
- other

A **welcome window** explains what the app is and how to run an assessment step by step. It opens on a visitor's first visit, and the **How to use** link in the header reopens it.

The **Layers box** at the bottom-left of the map lists everything in one vertical list:

- **Basemap:** OpenStreetMap, Humanitarian (HOT), Light, Topographic (OpenTopoMap) or Satellite (Esri).
- **Layer switches,** each with its legend symbol beside it. Facility categories and road types expand on demand.
- **Colour ramps** for flood depth, social vulnerability and multi-hazard, shown while that layer is on. Only one of these three building colourings shows at a time.
- Layers that need an analysis step to run first are greyed out until they have data.

The box collapses to a single button, and starts collapsed on phones.

The **3D** button on the map turns on 3D terrain (with hillshade and a height-exaggeration slider) and raises buildings to their real height (storeys × 3 m), coloured by the active layer. Right-drag or Ctrl+drag to tilt and rotate. Exported maps always stay flat and north-up.

## Versions and citation

OpenHVRA uses version numbers so that results can be traced back to the methods that produced them.

- **0.x → 0.(x+1)**: a method changed, so results may differ.
- **0.x.y → 0.x.(y+1)**: fixes and small additions.
- **1.0.0**: validated methods, end of beta.

The version appears in the app header and on every exported map, chart, CSV and report.

**To find an old version:**

- The [Releases page](https://github.com/gomalhunzai/openhvra/releases) lists every version with notes and a *Source code (zip)* download.
- Browse a version's code at `https://github.com/gomalhunzai/openhvra/tree/v0.9.0`, replacing the version number.
- To run an old version, unzip it and run `node serve.mjs`. The live site always runs the latest version.

**To cite:** use the *Cite this repository* button on the GitHub page (generated from [`CITATION.cff`](CITATION.cff)), and include the version you used.

## Run locally

```sh
node serve.mjs        # then open http://localhost:8080
```

There is no build step and nothing to install. Any static server works.

## Deploy for free

The app is plain static files, so you can host it on GitHub Pages (*Settings → Pages → Deploy from branch*), Netlify or Cloudflare Pages.

## Code layout

| File | Purpose |
|---|---|
| `js/osm.js` | Overpass queries (light and footprint modes), parallel download with fallback, IndexedDB cache, parsing and classification |
| `js/analysis.js` | `Dataset`: area clipping, population model, cursor probe, distance exposure |
| `js/risk.js` | Elevation tiles, flood-depth model, depth-damage curves, AAL and risk-finance layers |
| `js/spatial.js` | Projection, grid index, distance and geometry helpers |
| `js/hazards.js` | Multi-hazard scoring, USGS and glacier/coast context data, multi-hazard index, combined risk, risk matrix |
| `js/social.js` | Social Vulnerability Index, census join, World Bank demographic shares |
| `js/upload.js` | Reading boundary files (Shapefile, GeoJSON, TopoJSON, KML/KMZ, GPX, GeoPackage, WKT), reprojection, simplification |
| `js/draw.js`, `js/controls.js` | Area drawing tool, map toolbar and basemap switcher |
| `js/chart.js` | Loss-exceedance curve (SVG) |
| `js/main.js` | Map, layers and UI |

## Limitations: read before using the results

These are **screening estimates**, intended for prioritisation, not engineering design.

- **OSM coverage varies.** Missing buildings mean missing people and losses. Check against the satellite basemap.
- **Population** is a floor-area model. Calibrate it with a census or WorldPop total whenever you can.
- **The flood hazard is a proxy.** "Height above nearest waterway" ignores flood defences, channel capacity, backwater effects and rainfall flooding. The elevation data is about 30 m resolution with several metres of vertical error, and often includes buildings and trees. Replace the default water levels with values from local hydrology or a flood study.
- **The multi-hazard scores are terrain and map proxies.** They don't model hazards physically: there is no flow routing for flash floods; GLOF paths are traced on ~30–60 m elevation where streams are unmapped and can go wrong in narrow gorges or flat valley floors (check them on the map and draw the path yourself if needed), no soil or rock data for landslides and earthquakes, and no snow climate for avalanches. Use them to find hotspots, then confirm with official hazard maps and field checks.
- **The social vulnerability index uses proxies.** Where OSM is missing clinics, shelters or roads, areas look more vulnerable than they are. Vulnerable-group counts apply national shares evenly, so for local differences upload census data.
- **The damage curves and costs are defaults.** Use national replacement costs, for example from the JRC or national statistics.
- **AAL** comes from a handful of scenarios: no damage is assumed below the most frequent one, and the rarest one's loss is assumed for anything rarer.
- **Risk-finance costs** (premium multiples, credit fees) are indicative. Real pricing depends on markets and on basis risk.
- Please respect the usage policies of [Overpass](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html), [OSM tiles](https://operations.osmfoundation.org/policies/tiles/), [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) and [OpenTopoMap](https://opentopomap.org/about). For heavy use, self-host or use commercial providers.

**Privacy:** visits are counted anonymously with [GoatCounter](https://www.goatcounter.com) (no cookies, no personal data). Files you upload are processed in your browser and are not sent anywhere.

Data © OpenStreetMap contributors (ODbL). Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/).

## License

The OpenHVRA code is released under the [MIT License](LICENSE): you may use, copy, modify and share it freely, including in other projects, as long as the copyright and license notice are kept.

Data used and produced by the app keep their own licenses. OpenStreetMap data is © OpenStreetMap contributors under the [ODbL](https://www.openstreetmap.org/copyright), which also applies to outputs derived from it (exported tables, layers and maps): credit OpenStreetMap when you share them.
