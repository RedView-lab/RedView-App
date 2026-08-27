import proj4 from 'proj4';
import type { JapanZoneNumber, JapanTileCoord, JapanMapSheetInfo, JapanTertiaryMeshInfo } from './types';
import type { Jgd2011ZoneCrs } from '../../types';

/**
 * Coordinate helpers for Japan LiDAR point clouds in JGD2011 Plane Rectangular Coordinate Systems (Zones 1 to 19).
 *
 * Japan uses JGD2011 (GRS80 ellipsoid) divided into 19 Plane Rectangular CS zones (EPSG:6669 to EPSG:6687).
 * Vertical datum: Tokyo Peil (T.P. / 東京湾平均海面).
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

// Register all 19 JGD2011 Plane Rectangular zones in Proj4
for (let z = 1; z <= 19; z++) {
  const def = JGD2011_ZONE_DEFS[z as JapanZoneNumber];
  const projString = `+proj=tmerc +lat_0=${def.lat0} +lon_0=${def.lon0} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs`;
  proj4.defs(def.epsg, projString);
  proj4.defs(def.crsName, projString);
}

// Bounding box covering all territory of Japan
export const JAPAN_BBOX_WGS84 = { west: 122.0, south: 20.0, east: 154.5, north: 46.0 };

/** Check if coordinates are inside Japan territory */
export function isInJapanCoverage(lon: number, lat: number): boolean {
  return (
    lon >= JAPAN_BBOX_WGS84.west &&
    lon <= JAPAN_BBOX_WGS84.east &&
    lat >= JAPAN_BBOX_WGS84.south &&
    lat <= JAPAN_BBOX_WGS84.north
  );
}

/** Automatically detect official JGD2011 zone (1..19) for given WGS84 coordinates */
export function detectJapanZone(lon: number, lat: number): JapanZoneNumber {
  // Nansei Islands / Okinawa / Remote
  if (lat < 28.0) {
    if (lon > 150.0) return 19; // Minamitorishima
    if (lon > 138.0 && lat < 21.0) return 18; // Okinotorishima
    if (lon > 139.0 && lon < 144.0) return 14; // Ogasawara
    if (lon > 130.0) return 17; // Daito
    if (lon > 126.0) return 15; // Okinawa Main Island
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
    if (lon < 139.8 && lat < 38.0) return 9; // Tochigi / Gunma border
    return 10;
  }

  // Kanto (Tokyo, Kanagawa, Saitama, Chiba, Ibaraki, Tochigi, Gunma)
  if (lon >= 138.9 && lon <= 140.9 && lat >= 34.8 && lat <= 37.2) {
    return 9;
  }

  // Chubu / Tokai (Shizuoka, Yamanashi, Nagano, Niigata)
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

  // Chugoku West (Hiroshima, Yamaguchi, Shimane)
  if (lon >= 130.8 && lon <= 133.5 && lat >= 33.8 && lat <= 36.5) {
    return 3;
  }

  // Kyushu East/Central
  if (lat >= 30.5 && lat <= 34.2 && lon >= 129.8 && lon <= 132.2) {
    return 2;
  }

  // Nagasaki, Tsushima, Goto
  if (lon < 130.0 && lat >= 31.5 && lat <= 35.0) {
    return 1;
  }

  // Fallback: Find zone with closest central meridian
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

/** Convert WGS84 [lon, lat] to native JGD2011 (East, North) in metres */
export function wgs84ToJapan(lon: number, lat: number, zone?: JapanZoneNumber): [number, number] {
  const z = zone ?? detectJapanZone(lon, lat);
  const def = JGD2011_ZONE_DEFS[z];
  return proj4(PROJ_WGS84, def.epsg, [lon, lat]) as [number, number];
}

/** Convert native JGD2011 (East, North) in metres to WGS84 [lon, lat] */
export function japanToWgs84(eastM: number, northM: number, zone: JapanZoneNumber): [number, number] {
  const def = JGD2011_ZONE_DEFS[zone];
  return proj4(def.epsg, PROJ_WGS84, [eastM, northM]) as [number, number];
}

/** Convert a WGS84 point to the SW-corner of its 1 km JGD2011 tile */
export function wgs84ToJapanTileCoord(lon: number, lat: number, zone?: JapanZoneNumber): JapanTileCoord {
  const z = zone ?? detectJapanZone(lon, lat);
  const [eastM, northM] = wgs84ToJapan(lon, lat, z);
  return {
    eastKm: Math.floor(eastM / 1000),
    northKm: Math.floor(northM / 1000),
    zone: z,
  };
}

/** Native JGD2011 bounds (metres) of the 1 km × 1 km tile */
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

/** Closed WGS84 ring (5 vertices) describing the 1km² tile footprint */
export function japanTileCoordToWgs84Polygon(coord: JapanTileCoord): [number, number][] {
  const { minE, minN, maxE, maxN } = getJapanTileBounds(coord);
  const sw = japanToWgs84(minE, minN, coord.zone);
  const se = japanToWgs84(maxE, minN, coord.zone);
  const ne = japanToWgs84(maxE, maxN, coord.zone);
  const nw = japanToWgs84(minE, maxN, coord.zone);
  return [sw, se, ne, nw, sw];
}

/** Centre of the tile in WGS84 [lon, lat] */
export function japanTileCenterWgs84(coord: JapanTileCoord): [number, number] {
  const { minE, minN } = getJapanTileBounds(coord);
  return japanToWgs84(minE + 500, minN + 500, coord.zone);
}

/** Stable string key for Japan tile cache / dedup */
export function japanTileKey(coord: JapanTileCoord): string {
  return `JP_Z${String(coord.zone).padStart(2, '0')}_E${coord.eastKm}_N${coord.northKm}`;
}

/** JIS X 0410 Tertiary Regional Mesh (3次メッシュ) 8-digit code */
export function wgs84ToTertiaryMesh(lon: number, lat: number): JapanTertiaryMeshInfo {
  const p = Math.floor(lat * 1.5);
  const u = Math.floor(lon - 100);
  const q = Math.floor((lat * 1.5 - p) * 8);
  const v = Math.floor((lon - 100 - u) * 8);
  const latRem = lat * 1.5 - p - q / 8;
  const lonRem = lon - 100 - u - v / 8;
  const r = Math.floor(latRem * 80);
  const w = Math.floor(lonRem * 80);

  const mesh1st = `${String(p).padStart(2, '0')}${String(u).padStart(2, '0')}`;
  const mesh2nd = `${q}${v}`;
  const mesh3rd = `${r}${w}`;
  const fullCode = `${mesh1st}${mesh2nd}${mesh3rd}`;

  return { mesh1st, mesh2nd, mesh3rd, fullCode };
}

/**
 * Convert native JGD2011 coordinates to Japanese Public Survey Standard Map Sheet info (公共測量標準図郭).
 * A 1:50,000 sheet is 40,000m × 30,000m.
 * A 1:5,000 sheet is 4,000m × 3,000m (numbered 00 to 99).
 * A 1:2,500 sub-sheet is 400m × 300m (numbered 00 to 99).
 */
export function japanCoordsToStandardSheet(eastM: number, northM: number, zone: JapanZoneNumber): JapanMapSheetInfo {
  const zoneStr = String(zone).padStart(2, '0');

  // North-South letter (30km rows from origin Y=0)
  const ROW_LETTERS_NORTH = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  const ROW_LETTERS_SOUTH = ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'];

  let rowLetter = 'J';
  let sheetNorthOrigin = 0;
  if (northM >= 0) {
    const rowIdx = Math.min(ROW_LETTERS_NORTH.length - 1, Math.floor(northM / 30000));
    rowLetter = ROW_LETTERS_NORTH[rowIdx];
    sheetNorthOrigin = rowIdx * 30000;
  } else {
    const rowIdx = Math.min(ROW_LETTERS_SOUTH.length - 1, Math.floor(Math.abs(northM) / 30000));
    rowLetter = ROW_LETTERS_SOUTH[rowIdx];
    sheetNorthOrigin = - (rowIdx * 30000);
  }

  // East-West letter (40km columns from origin X=0)
  const COL_LETTERS_WEST = ['D', 'C', 'B', 'A']; // West of origin
  const COL_LETTERS_EAST = ['E', 'F', 'G', 'H']; // East of origin

  let colLetter = 'E';
  let sheetWestOrigin = 0;
  if (eastM >= 0) {
    const colIdx = Math.min(COL_LETTERS_EAST.length - 1, Math.floor(eastM / 40000));
    colLetter = COL_LETTERS_EAST[colIdx];
    sheetWestOrigin = colIdx * 40000;
  } else {
    const colIdx = Math.min(COL_LETTERS_WEST.length - 1, Math.floor(Math.abs(eastM) / 40000));
    colLetter = COL_LETTERS_WEST[colIdx];
    sheetWestOrigin = - ((colIdx + 1) * 40000);
  }

  // 1:5,000 sheet numbers (00 to 99): 10 rows of 3,000m, 10 cols of 4,000m
  const sub5kCol = Math.min(9, Math.max(0, Math.floor((eastM - sheetWestOrigin) / 4000)));
  const sub5kRow = Math.min(9, Math.max(0, Math.floor((Math.abs(northM - sheetNorthOrigin)) / 3000)));
  const sheet5k = `${sub5kRow}${sub5kCol}`;

  // 1:2,500 / 1:500 sub-sheet numbers (00 to 99): 10 rows of 300m, 10 cols of 400m
  const sheet5kWest = sheetWestOrigin + sub5kCol * 4000;
  const sheet5kNorth = sheetNorthOrigin + (northM >= 0 ? sub5kRow * 3000 : - (sub5kRow * 3000));
  const subCol = Math.min(9, Math.max(0, Math.floor((eastM - sheet5kWest) / 400)));
  const subRow = Math.min(9, Math.max(0, Math.floor(Math.abs(northM - sheet5kNorth) / 300)));
  const subSheet = `${subRow}${subCol}`;

  const sheetCode = `${zoneStr}${rowLetter}${colLetter}${sheet5k}${subSheet}`;

  return {
    zone,
    zoneStr,
    rowLetter,
    colLetter,
    sheet5k,
    subSheet,
    sheetCode,
  };
}
