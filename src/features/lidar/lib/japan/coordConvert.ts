import proj4 from 'proj4';
import type { JapanZoneNumber, JapanTileCoord } from './types';
import type { Jgd2011ZoneCrs } from '../../types';

/**
 * Outils de coordonnées pour les nuages de points LiDAR japonais dans les systèmes plans rectangulaires JGD2011 (zones 1 à 19).
 *
 * Le Japon utilise le JGD2011 (ellipsoïde GRS80) découpé en 19 zones de systèmes plans rectangulaires (EPSG:6669 à EPSG:6687).
 * Référence verticale : Tokyo Peil (T.P. / 東京湾平均海面).
 */

const PROJ_WGS84 = 'EPSG:4326';

export interface Jgd2011ZoneDef {
  zone: JapanZoneNumber;
  epsg: string;
  crsName: Jgd2011ZoneCrs;
  lat0: number;
  lon0: number;
  description: string;
}

export const JGD2011_ZONE_DEFS: Record<JapanZoneNumber, Jgd2011ZoneDef> = {
  1: { zone: 1, epsg: 'EPSG:6669', crsName: 'JGD2011_ZONE_01', lat0: 33.0, lon0: 129.5, description: 'Nagasaki, Tsushima, Goto' },
  2: { zone: 2, epsg: 'EPSG:6670', crsName: 'JGD2011_ZONE_02', lat0: 33.0, lon0: 131.0, description: 'Fukuoka, Saga, Kumamoto, Oita, Miyazaki, Kagoshima' },
  3: { zone: 3, epsg: 'EPSG:6671', crsName: 'JGD2011_ZONE_03', lat0: 36.0, lon0: 132.166666666667, description: 'Yamaguchi, Shimane, Hiroshima' },
  4: { zone: 4, epsg: 'EPSG:6672', crsName: 'JGD2011_ZONE_04', lat0: 33.0, lon0: 133.5, description: 'Kagawa, Ehime, Tokushima, Kochi' },
  5: { zone: 5, epsg: 'EPSG:6673', crsName: 'JGD2011_ZONE_05', lat0: 36.0, lon0: 134.333333333333, description: 'Hyogo, Tottori, Okayama' },
  6: { zone: 6, epsg: 'EPSG:6674', crsName: 'JGD2011_ZONE_06', lat0: 36.0, lon0: 136.0, description: 'Kyoto, Osaka, Fukui, Shiga, Mie, Nara, Wakayama' },
  7: { zone: 7, epsg: 'EPSG:6675', crsName: 'JGD2011_ZONE_07', lat0: 36.0, lon0: 137.166666666667, description: 'Ishikawa, Toyama, Gifu, Aichi' },
  8: { zone: 8, epsg: 'EPSG:6676', crsName: 'JGD2011_ZONE_08', lat0: 36.0, lon0: 138.5, description: 'Niigata, Nagano, Yamanashi, Shizuoka' },
  9: { zone: 9, epsg: 'EPSG:6677', crsName: 'JGD2011_ZONE_09', lat0: 36.0, lon0: 139.833333333333, description: 'Tokyo, Kanagawa, Saitama, Chiba, Ibaraki, Tochigi, Gunma' },
  10: { zone: 10, epsg: 'EPSG:6678', crsName: 'JGD2011_ZONE_10', lat0: 40.0, lon0: 140.833333333333, description: 'Aomori, Akita, Yamagata, Iwate, Miyagi, Fukushima' },
  11: { zone: 11, epsg: 'EPSG:6679', crsName: 'JGD2011_ZONE_11', lat0: 44.0, lon0: 140.25, description: 'West Hokkaido' },
  12: { zone: 12, epsg: 'EPSG:6680', crsName: 'JGD2011_ZONE_12', lat0: 44.0, lon0: 142.25, description: 'Central Hokkaido' },
  13: { zone: 13, epsg: 'EPSG:6681', crsName: 'JGD2011_ZONE_13', lat0: 44.0, lon0: 144.25, description: 'East Hokkaido' },
  14: { zone: 14, epsg: 'EPSG:6682', crsName: 'JGD2011_ZONE_14', lat0: 26.0, lon0: 142.0, description: 'Ogasawara Islands' },
  15: { zone: 15, epsg: 'EPSG:6683', crsName: 'JGD2011_ZONE_15', lat0: 26.0, lon0: 127.5, description: 'Okinawa Main Island' },
  16: { zone: 16, epsg: 'EPSG:6684', crsName: 'JGD2011_ZONE_16', lat0: 26.0, lon0: 124.0, description: 'Miyako, Yaeyama' },
  17: { zone: 17, epsg: 'EPSG:6685', crsName: 'JGD2011_ZONE_17', lat0: 26.0, lon0: 131.0, description: 'Daito Islands' },
  18: { zone: 18, epsg: 'EPSG:6686', crsName: 'JGD2011_ZONE_18', lat0: 20.0, lon0: 136.0, description: 'Okinotorishima' },
  19: { zone: 19, epsg: 'EPSG:6687', crsName: 'JGD2011_ZONE_19', lat0: 26.0, lon0: 154.0, description: 'Minamitorishima' },
};

// Enregistre dans Proj4 les 19 zones planes rectangulaires JGD2011
for (let z = 1; z <= 19; z++) {
  const def = JGD2011_ZONE_DEFS[z as JapanZoneNumber];
  const projString = `+proj=tmerc +lat_0=${def.lat0} +lon_0=${def.lon0} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs`;
  proj4.defs(def.epsg, projString);
  proj4.defs(def.crsName, projString);
}

// Emprise couvrant tout le territoire japonais
const JAPAN_BBOX_WGS84 = { west: 122.0, south: 20.0, east: 154.5, north: 46.0 };

/** Indique si les coordonnées sont sur le territoire japonais */
export function isInJapanCoverage(lon: number, lat: number): boolean {
  return (
    lon >= JAPAN_BBOX_WGS84.west &&
    lon <= JAPAN_BBOX_WGS84.east &&
    lat >= JAPAN_BBOX_WGS84.south &&
    lat <= JAPAN_BBOX_WGS84.north
  );
}

/** Détecte automatiquement la zone officielle JGD2011 (1..19) de coordonnées WGS84 */
function detectJapanZone(lon: number, lat: number): JapanZoneNumber {
  // Îles Nansei / Okinawa / îles éloignées
  if (lat < 28.0) {
    if (lon > 150.0) return 19; // Minamitorishima
    if (lon > 138.0 && lat < 21.0) return 18; // Okinotorishima
    if (lon > 139.0 && lon < 144.0) return 14; // Ogasawara
    if (lon > 130.0) return 17; // Daito
    if (lon > 126.0) return 15; // Île principale d'Okinawa
    return 16; // Miyako / Yaeyama
  }

  // Hokkaido
  if (lat >= 41.3 && lon >= 139.0) {
    if (lon < 141.25) return 11;
    if (lon < 143.25) return 12;
    return 13;
  }

  // Tohoku
  if (lat >= 36.8 && lon >= 139.6 && lat < 41.5) {
    if (lon < 139.8 && lat < 38.0) return 9; // Limite Tochigi / Gunma
    return 10;
  }

  // Kanto (Tokyo, Kanagawa, Saitama, Chiba, Ibaraki, Tochigi, Gunma)
  if (lon >= 138.9 && lon <= 140.9 && lat >= 34.8 && lat <= 37.2) {
    return 9;
  }

  // Chūbu / Tōkai (Shizuoka, Yamanashi, Nagano, Niigata)
  if (lon >= 137.5 && lon <= 139.2 && lat >= 34.5 && lat <= 38.5) {
    return 8;
  }

  // Hokuriku / Aichi / Gifu / Toyama / Ishikawa
  if (lon >= 136.4 && lon <= 137.6 && lat >= 34.5 && lat <= 37.8) {
    return 7;
  }

  // Kansai (Kyoto, Osaka, Shiga, Mie, Nara, Wakayama)
  if (lon >= 135.2 && lon <= 136.5 && lat >= 33.4 && lat <= 36.0) {
    return 6;
  }

  // Hyogo / Tottori / Okayama
  if (lon >= 133.5 && lon <= 135.3 && lat >= 34.0 && lat <= 36.0) {
    return 5;
  }

  // Shikoku
  if (lat >= 32.7 && lat <= 34.5 && lon >= 132.0 && lon <= 134.6) {
    return 4;
  }

  // Chūgoku ouest (Hiroshima, Yamaguchi, Shimane)
  if (lon >= 130.8 && lon <= 133.5 && lat >= 33.8 && lat <= 36.5) {
    return 3;
  }

  // Kyūshū est/centre
  if (lat >= 30.5 && lat <= 34.2 && lon >= 129.8 && lon <= 132.2) {
    return 2;
  }

  // Nagasaki, Tsushima, Goto
  if (lon < 130.0 && lat >= 31.5 && lat <= 35.0) {
    return 1;
  }

  // Repli : zone dont le méridien central est le plus proche
  let bestZone: JapanZoneNumber = 9;
  let minDiff = Infinity;
  for (let z = 1; z <= 13; z++) {
    const diff = Math.abs(lon - JGD2011_ZONE_DEFS[z as JapanZoneNumber].lon0);
    if (diff < minDiff) {
      minDiff = diff;
      bestZone = z as JapanZoneNumber;
    }
  }
  return bestZone;
}

/** Convertit un WGS84 [lon, lat] en JGD2011 natif (Est, Nord) en mètres */
export function wgs84ToJapan(lon: number, lat: number, zone?: JapanZoneNumber): [number, number] {
  const z = zone ?? detectJapanZone(lon, lat);
  const def = JGD2011_ZONE_DEFS[z];
  return proj4(PROJ_WGS84, def.epsg, [lon, lat]) as [number, number];
}

/** Convertit un JGD2011 natif (Est, Nord) en mètres en WGS84 [lon, lat] */
export function japanToWgs84(eastM: number, northM: number, zone: JapanZoneNumber): [number, number] {
  const def = JGD2011_ZONE_DEFS[zone];
  return proj4(def.epsg, PROJ_WGS84, [eastM, northM]) as [number, number];
}

/** Convertit un point WGS84 en coin SO de sa tuile JGD2011 de 1 km */
export function wgs84ToJapanTileCoord(lon: number, lat: number, zone?: JapanZoneNumber): JapanTileCoord {
  const z = zone ?? detectJapanZone(lon, lat);
  const [eastM, northM] = wgs84ToJapan(lon, lat, z);
  return {
    eastKm: Math.floor(eastM / 1000),
    northKm: Math.floor(northM / 1000),
    zone: z,
  };
}

/** Emprise JGD2011 native (mètres) de la tuile de 1 km × 1 km */
export function getJapanTileBounds(coord: JapanTileCoord): {
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

/** Clé texte stable pour le cache / la déduplication des tuiles japonaises */
export function japanTileKey(coord: JapanTileCoord): string {
  return `JP_Z${String(coord.zone).padStart(2, '0')}_E${coord.eastKm}_N${coord.northKm}`;
}


