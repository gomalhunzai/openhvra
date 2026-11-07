// Elevation source used by every analysis: Copernicus DEM GLO-30 by default,
// or the AWS Terrain Tiles. If Copernicus can't be downloaded, the Terrain
// Tiles are used instead and the DEM records why (dem.fallback).

import { loadDEM } from './risk.js';
import { loadCopDEM, COPDEM_CREDIT } from './copdem.js';

export const ELEVATION_SOURCES = {
  copernicus: {
    label: 'Copernicus DEM GLO-30',
    short: 'Copernicus DEM GLO-30 (© DLR e.V., © Airbus DS, EU/ESA)',
    credit: COPDEM_CREDIT,
    via: 'Microsoft Planetary Computer',
  },
  terrain: {
    label: 'AWS Terrain Tiles',
    short: 'AWS Terrain Tiles',
    credit: 'AWS Terrain Tiles (SRTM and others, via Mapzen/Tilezen)',
    via: 'AWS Open Data',
  },
};

let current = 'copernicus';
export function setElevationSource(key) {
  if (ELEVATION_SOURCES[key]) current = key;
}
export function elevationSource() {
  return current;
}

// What each kind of request needs from either source:
//   area     the analysed area (flood, exposure, multi-hazard)
//   regional the wide area around glacial lakes, for tracing outflow paths
//   point    the elevation of one spot (a lake surface)
const OPTIONS = {
  area: { cop: { maxPixels: 4e6 }, terrain: { maxZoom: 14, maxTiles: 36 } },
  regional: { cop: { maxPixels: 3e6, minLevel: 1 }, terrain: { maxZoom: 12, maxTiles: 64 } },
  point: { cop: { maxPixels: 4e4, minLevel: 1 }, terrain: { maxZoom: 14, maxTiles: 36 } },
};

export async function loadElevation(bbox, { signal, onProgress, kind = 'area', source = current } = {}) {
  const o = OPTIONS[kind];
  if (source === 'copernicus') {
    try {
      return await loadCopDEM(bbox, { signal, onProgress, ...o.cop });
    } catch (err) {
      if (signal?.aborted) throw err;
      const dem = await loadDEM(bbox, { signal, onProgress, ...o.terrain });
      dem.fallback = `Copernicus DEM unavailable (${err.message}); used AWS Terrain Tiles instead`;
      return dem;
    }
  }
  return loadDEM(bbox, { signal, onProgress, ...o.terrain });
}

// Credit line for the source a DEM actually came from.
export function elevationCredit(dem) {
  return ELEVATION_SOURCES[dem?.source ?? current].credit;
}
