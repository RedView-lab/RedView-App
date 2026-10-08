import proj4 from 'proj4';
import type { NzTileCoord } from './types';

/**
 * Outils de coordonnées pour les tuiles LiDAR néo-zélandaises en NZTM2000 (EPSG:2193).
 *
 * Fausse origine du NZTM2000 en (E=1 600 000 m, N=10 000 000 m) avec lat_0=0, lon_0=173°E.
 * La Nouvelle-Zélande s'étend à peu près sur :
 *   Est (E) : 1 000 000 .. 2 200 000 m (1000 .. 2200 km)
 *   Nord (N) : 4 700 000 .. 6 300 000 m (4700 .. 6300 km)
 */

export const PROJ_NZTM2000 = 'EPSG:2193';
const PROJ_WGS84 = 'EPSG:4326';

// Définition officielle NZGD2000 / NZTM2000
proj4.defs(
  PROJ_NZTM2000,
  '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs'
);

// Emprise géographique couvrant la Nouvelle-Zélande (île du Nord, île du Sud, île Stewart)
const NZ_BBOX_WGS84 = { west: 165.5, south: -47.8, east: 179.5, north: -33.8 };

/** Convertit un NZTM2000 (E, N) en mètres en WGS84 [lon, lat]. */
export function nzToWgs84(eastM: number, northM: number): [number, number] {
  return proj4(PROJ_NZTM2000, PROJ_WGS84, [eastM, northM]) as [number, number];
}

/** Convertit un WGS84 [lon, lat] en NZTM2000 [est, nord] en mètres. */
export function wgs84ToNz(lon: number, lat: number): [number, number] {
  return proj4(PROJ_WGS84, PROJ_NZTM2000, [lon, lat]) as [number, number];
}

/** Test rapide d'emprise : (lon, lat) est-il dans la couverture néo-zélandaise ? */
export function isInNzCoverage(lon: number, lat: number): boolean {
  // Îles principales et îles Chatham (lon ~ -177°, lat ~ -44°)
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

/** Convertit un point WGS84 en coin SO de sa tuile NZTM2000 de 1 km. */
export function wgs84ToNzTileCoord(lon: number, lat: number): NzTileCoord {
  const [east, north] = wgs84ToNz(lon, lat);
  return {
    eastKm: Math.floor(east / 1000),
    northKm: Math.floor(north / 1000),
  };
}

/** Emprise NZTM2000 native (mètres) de la tuile de 1 km × 1 km. */
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

/** Clé texte stable pour les caches / la déduplication. */
export function nzTileKey(coord: NzTileCoord): string {
  return `${coord.eastKm}-${coord.northKm}`;
}
