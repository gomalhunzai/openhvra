# OSM Proximity Explorer

A free web map for disaster risk practitioners. It shows how many people, buildings and critical facilities lie near rivers, streams and roads, and estimates what floods could cost and how to finance them. Everything comes from open data: OpenStreetMap and open elevation tiles.

## What it does

1. **Area & data**
   - Choose an area by drawing a **rectangle**, **circle** or **polygon** (with the buttons in the panel or the toolbar at the map's top-left), or use the current view.
   - Pick which layers to download. **Light** mode (the default) downloads building bounding boxes instead of full footprints, which is about 3× smaller, and estimates each building's area from its box. Facilities are downloaded as centre points only.
   - Buildings and the remaining layers download in parallel, falling back across public Overpass servers. Downloads are cached in the browser for 3 days, so reloading the same area is instant.
2. **Population model**: estimates residents per building as residential floor area (footprint × storeys) ÷ floor area per person. Enter a census total to calibrate. Buildings are split into residential, commercial, industrial, public and ancillary classes.
3. **Cursor probe**: a circle (25–1000 m) follows the mouse and shows live counts of residents, buildings and facilities, road and waterway length, and the distance to the nearest waterway and major road.
4. **Exposure by distance**: counts and maps everything within *X* m of rivers, streams or roads, and lists the critical facilities at risk.
5. **Flood risk & risk finance**
   - **Hazard**: estimates flood depth at each building from its *height above the nearest waterway*, using open elevation data. You enter the water level for each return period, for example the 5-, 10-, 25-, 50-, 100- and 500-year floods.
   - **Vulnerability**: depth-damage curves for residential, commercial and industrial buildings (approximately the JRC global curves for Asia, Huizinga et al. 2017), applied to replacement cost per m² plus contents.
   - **Risk metrics**: for each scenario, the loss, people affected and critical facilities flooded. Also a **loss-exceedance curve**, the **average annual loss (AAL)**, the expected number of people affected per year, and a landslide screen based on slope.
   - **Risk finance**: splits the loss curve into layers: *retain* (reserve fund), *borrow* (contingent credit), *transfer* (parametric insurance or cat bond) and *residual*. Each layer shows its expected annual loss and an indicative annual cost.
6. **Exports**: lightweight GeoJSON (points, coordinates rounded to 6 decimals, essential fields only) and CSV, for both the exposure results and the building-level risk results (depth, loss per scenario, AAL per building).

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

**Basemaps** are switched with the layers button on the map: OpenStreetMap, Humanitarian (HOT), Light, Topographic (OpenTopoMap) and Satellite (Esri).

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
| `js/draw.js`, `js/controls.js` | Area drawing tool, map toolbar and basemap switcher |
| `js/chart.js` | Loss-exceedance curve (SVG) |
| `js/main.js` | Map, layers and UI |

## Limitations: read before using the results

These are **screening estimates**, intended for prioritisation, not engineering design.

- **OSM coverage varies.** Missing buildings mean missing people and losses. Check against the satellite basemap.
- **Population** is a floor-area model. Calibrate it with a census or WorldPop total whenever you can.
- **The flood hazard is a proxy.** "Height above nearest waterway" ignores flood defences, channel capacity, backwater effects and rainfall flooding. The elevation data is about 30 m resolution with several metres of vertical error, and often includes buildings and trees. Replace the default water levels with values from local hydrology or a flood study.
- **The damage curves and costs are defaults.** Use national replacement costs, for example from the JRC or national statistics.
- **AAL** comes from a handful of scenarios: no damage is assumed below the most frequent one, and the rarest one's loss is assumed for anything rarer.
- **Risk-finance costs** (premium multiples, credit fees) are indicative. Real pricing depends on markets and on basis risk.
- Please respect the usage policies of [Overpass](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html), [OSM tiles](https://operations.osmfoundation.org/policies/tiles/), [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) and [OpenTopoMap](https://opentopomap.org/about). For heavy use, self-host or use commercial providers.

Data © OpenStreetMap contributors (ODbL). Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/).
