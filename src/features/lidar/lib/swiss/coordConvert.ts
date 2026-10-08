import proj4 from 'proj4';
import type { SwissTileCoord } from './types';

/**
 * Outils de coordonnées pour les tuiles swissSURFACE3D en CH1903+ / LV95 (EPSG:2056).
 *
 * Origine LV95 en (E=2 600 000 m, N=1 200 000 m) au centre de projection
 * (observatoire de Berne). La Suisse s'étend à peu près sur :
 *   E : 2 480 000 .. 2 840 000 m
 *   N : 1 070 000 .. 1 300 000 m
 */

const PROJ_LV95 = 'EPSG:2056';
const PROJ_WGS84 = 'EPSG:4326';

// CH1903+ / LV95 — définition officielle swisstopo.
proj4.defs(
  PROJ_LV95,
  '+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 ' +
    '+x_0=2600000 +y_0=1200000 +ellps=bessel ' +
    '+towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs +type=crs'
);

// Emprise prudente couvrant la Suisse + le Liechtenstein (avec marge).
// Sert aux tests rapides « ce point est-il dans la couverture CH ? ».
const CH_BBOX_WGS84 = { west: 5.85, south: 45.75, east: 10.55, north: 47.85 };

/** Convertit un LV95 (E, N) en mètres en WGS84 [lon, lat]. */
export function swissToWgs84(eastM: number, northM: number): [number, number] {
  return proj4(PROJ_LV95, PROJ_WGS84, [eastM, northM]) as [number, number];
}

/** Convertit un WGS84 [lon, lat] en LV95 [est, nord] en mètres. */
export function wgs84ToSwiss(lon: number, lat: number): [number, number] {
  return proj4(PROJ_WGS84, PROJ_LV95, [lon, lat]) as [number, number];
}

/** Test rapide d'emprise : (lon, lat) est-il dans la couverture LiDAR suisse ? */
export function isInSwissCoverage(lon: number, lat: number): boolean {
  return (
    lon >= CH_BBOX_WGS84.west &&
    lon <= CH_BBOX_WGS84.east &&
    lat >= CH_BBOX_WGS84.south &&
    lat <= CH_BBOX_WGS84.north
  );
}

/** Convertit un point WGS84 en coin SO de sa tuile swissSURFACE3D de 1 km. */
export function wgs84ToSwissTileCoord(lon: number, lat: number): SwissTileCoord {
  const [east, north] = wgs84ToSwiss(lon, lat);
  return {
    eastKm: Math.floor(east / 1000),
    northKm: Math.floor(north / 1000),
  };
}

/** Emprise LV95 native (mètres) de la tuile de 1 km × 1 km. */
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

/** Centre de la tuile en WGS84 [lon, lat]. */
export function swissTileCenterWgs84(coord: SwissTileCoord): [number, number] {
  const { minE, minN } = getSwissTileBounds(coord);
  return swissToWgs84(minE + 500, minN + 500);
}

/** Clé texte stable pour les caches / la déduplication. */
export function swissTileKey(coord: SwissTileCoord): string {
  return `${coord.eastKm}-${coord.northKm}`;
}
