import proj4 from 'proj4';
import type { SwissTileCoord } from './types';

/**
 * Coordinate helpers for swissSURFACE3D tiles in CH1903+ / LV95 (EPSG:2056).
 *
 * LV95 origin is at (E=2 600 000 m, N=1 200 000 m) of the projection center
 * (Bern observatory). Switzerland spans roughly:
 *   E: 2 480 000 .. 2 840 000 m
 *   N: 1 070 000 .. 1 300 000 m
 */

const PROJ_LV95 = 'EPSG:2056';
const PROJ_WGS84 = 'EPSG:4326';

// CH1903+ / LV95 — official swisstopo definition.
proj4.defs(
  PROJ_LV95,
  '+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 ' +
    '+x_0=2600000 +y_0=1200000 +ellps=bessel ' +
    '+towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs +type=crs'
);

// Conservative bbox covering Switzerland + Liechtenstein (with margin).
// Used for fast "is this point in CH coverage?" checks.
const CH_BBOX_WGS84 = { west: 5.85, south: 45.75, east: 10.55, north: 47.85 };

/** Convert LV95 (E, N) in metres to WGS84 [lon, lat]. */
export function swissToWgs84(eastM: number, northM: number): [number, number] {
  return proj4(PROJ_LV95, PROJ_WGS84, [eastM, northM]) as [number, number];
}

/** Convert WGS84 [lon, lat] to LV95 [east, north] in metres. */
export function wgs84ToSwiss(lon: number, lat: number): [number, number] {
  return proj4(PROJ_WGS84, PROJ_LV95, [lon, lat]) as [number, number];
}

/** Quick bbox check: is (lon, lat) inside Switzerland LiDAR coverage? */
export function isInSwissCoverage(lon: number, lat: number): boolean {
  return (
    lon >= CH_BBOX_WGS84.west &&
    lon <= CH_BBOX_WGS84.east &&
    lat >= CH_BBOX_WGS84.south &&
    lat <= CH_BBOX_WGS84.north
  );
}

/** Convert a WGS84 point to the SW-corner of its 1 km swissSURFACE3D tile. */
export function wgs84ToSwissTileCoord(lon: number, lat: number): SwissTileCoord {
  const [east, north] = wgs84ToSwiss(lon, lat);
  return {
    eastKm: Math.floor(east / 1000),
    northKm: Math.floor(north / 1000),
  };
}

/** Native LV95 bounds (metres) of the 1 km × 1 km tile. */
export function getSwissTileBounds(coord: SwissTileCoord): {
  minE: number;
  minN: number;
  maxE: number;
  maxN: number;
} {
  return {
    minE: coord.eastKm * 1000,
    minN: coord.northKm * 1000,
    maxE: (coord.eastKm + 1) * 1000,
    maxN: (coord.northKm + 1) * 1000,
  };
}

/** Closed WGS84 ring (5 vertices) describing the tile footprint. */
export function swissTileCoordToWgs84Polygon(
  coord: SwissTileCoord
): [number, number][] {
  const { minE, minN, maxE, maxN } = getSwissTileBounds(coord);
  const sw = swissToWgs84(minE, minN);
  const se = swissToWgs84(maxE, minN);
  const ne = swissToWgs84(maxE, maxN);
  const nw = swissToWgs84(minE, maxN);
  return [sw, se, ne, nw, sw];
}

/** Centre of the tile in WGS84 [lon, lat]. */
export function swissTileCenterWgs84(coord: SwissTileCoord): [number, number] {
  const { minE, minN } = getSwissTileBounds(coord);
  return swissToWgs84(minE + 500, minN + 500);
}

/** Stable string key for caches / dedup. */
export function swissTileKey(coord: SwissTileCoord): string {
  return `${coord.eastKm}-${coord.northKm}`;
}
