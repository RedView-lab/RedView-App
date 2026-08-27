import proj4 from 'proj4';
import type { NzTileCoord } from './types';

/**
 * Coordinate helpers for New Zealand LiDAR tiles in NZTM2000 (EPSG:2193).
 *
 * NZTM2000 origin is at (E=1 600 000 m, N=10 000 000 m false origin with lat_0=0, lon_0=173°E).
 * New Zealand spans roughly:
 *   Easting (E): 1 000 000 .. 2 200 000 m (1000 .. 2200 km)
 *   Northing (N): 4 700 000 .. 6 300 000 m (4700 .. 6300 km)
 */

export const PROJ_NZTM2000 = 'EPSG:2193';
const PROJ_WGS84 = 'EPSG:4326';

// NZGD2000 / NZTM2000 official definition
proj4.defs(
  PROJ_NZTM2000,
  '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs'
);

// Geographic bounding box covering New Zealand (North Island, South Island, Stewart Island)
const NZ_BBOX_WGS84 = { west: 165.5, south: -47.8, east: 179.5, north: -33.8 };

/** Convert NZTM2000 (E, N) in metres to WGS84 [lon, lat]. */
export function nzToWgs84(eastM: number, northM: number): [number, number] {
  return proj4(PROJ_NZTM2000, PROJ_WGS84, [eastM, northM]) as [number, number];
}

/** Convert WGS84 [lon, lat] to NZTM2000 [east, north] in metres. */
export function wgs84ToNz(lon: number, lat: number): [number, number] {
  return proj4(PROJ_WGS84, PROJ_NZTM2000, [lon, lat]) as [number, number];
}

/** Quick bbox check: is (lon, lat) inside New Zealand coverage? */
export function isInNzCoverage(lon: number, lat: number): boolean {
  // Support Main Islands and Chatham Islands (lon ~ -177°, lat ~ -44°)
  const inMain = (
    lon >= NZ_BBOX_WGS84.west &&
    lon <= NZ_BBOX_WGS84.east &&
    lat >= NZ_BBOX_WGS84.south &&
    lat <= NZ_BBOX_WGS84.north
  );
  if (inMain) return true;
  const inChatham = (lon >= -177.5 && lon <= -175.5 && lat >= -44.5 && lat <= -43.5);
  return inChatham;
}

/** Convert a WGS84 point to the SW-corner of its 1 km NZTM2000 tile. */
export function wgs84ToNzTileCoord(lon: number, lat: number): NzTileCoord {
  const [east, north] = wgs84ToNz(lon, lat);
  return {
    eastKm: Math.floor(east / 1000),
    northKm: Math.floor(north / 1000),
  };
}

/** Native NZTM2000 bounds (metres) of the 1 km × 1 km tile. */
export function getNzTileBounds(coord: NzTileCoord): {
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
export function nzTileCoordToWgs84Polygon(
  coord: NzTileCoord
): [number, number][] {
  const { minE, minN, maxE, maxN } = getNzTileBounds(coord);
  const sw = nzToWgs84(minE, minN);
  const se = nzToWgs84(maxE, minN);
  const ne = nzToWgs84(maxE, maxN);
  const nw = nzToWgs84(minE, maxN);
  return [sw, se, ne, nw, sw];
}

/** Centre of the tile in WGS84 [lon, lat]. */
export function nzTileCenterWgs84(coord: NzTileCoord): [number, number] {
  const { minE, minN } = getNzTileBounds(coord);
  return nzToWgs84(minE + 500, minN + 500);
}

/** Stable string key for caches / dedup. */
export function nzTileKey(coord: NzTileCoord): string {
  return `${coord.eastKm}-${coord.northKm}`;
}
