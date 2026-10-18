# Changelog

All notable changes to OpenHVRA are listed here. Versions follow [semantic versioning](https://semver.org):

- **0.x → 0.(x+1)**: a method changed, so results may differ from the previous version.
- **0.x.y → 0.x.(y+1)**: fixes and small additions; results unchanged.
- **1.0.0** will mark validated methods and the end of the beta.

Every exported map, chart, CSV and report states the version that produced it. The code for any version is on the [Releases page](https://github.com/gomalhunzai/openhvra/releases).

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

[0.10.0]: https://github.com/gomalhunzai/openhvra/releases/tag/v0.10.0
[0.9.1]: https://github.com/gomalhunzai/openhvra/releases/tag/v0.9.1
[0.9.0]: https://github.com/gomalhunzai/openhvra/releases/tag/v0.9.0
