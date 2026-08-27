import proj4 from 'proj4';
import type { DetectedCrs, Territory, AltitudeRef, TileCoord, Jgd2011ZoneCrs } from '../types';
import {
  isInSwissCoverage,
  swissToWgs84,
  wgs84ToSwiss,
  wgs84ToSwissTileCoord,
} from './swiss/coordConvert';
import {
  isInNzCoverage,
  nzToWgs84,
  wgs84ToNz,
  wgs84ToNzTileCoord,
  PROJ_NZTM2000,
} from './nz/coordConvert';
import {
  isInJapanCoverage,
  japanToWgs84,
  wgs84ToJapan,
  wgs84ToJapanTileCoord,
  JGD2011_ZONE_DEFS,
  type JapanZoneNumber,
} from './japan';

// Register Lambert93 (EPSG:2154)
proj4.defs('EPSG:2154', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');

// Register RGR92 / UTM 40S (EPSG:2975) — Réunion
proj4.defs('EPSG:2975', '+proj=utm +zone=40 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');

// Register NZTM2000 (EPSG:2193) — New Zealand
proj4.defs('EPSG:2193', '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');

const PROJ_LAMB93 = 'EPSG:2154';
const PROJ_UTM40S = 'EPSG:2975';
const PROJ_LV95 = 'EPSG:2056';
const PROJ_WGS84 = 'EPSG:4326';

export function isJgd2011Crs(crs: string): crs is Jgd2011ZoneCrs {
  return typeof crs === 'string' && crs.startsWith('JGD2011_ZONE_');
}

export function parseJgd2011Zone(crs: string): JapanZoneNumber {
  const match = crs.match(/^JGD2011_ZONE_(\d{2})$/);
  if (match) {
    return parseInt(match[1], 10) as JapanZoneNumber;
  }
  return 9;
}

export function detectCrs(minY: number, maxY: number, minX?: number, maxX?: number): DetectedCrs {
  const meanY = (minY + maxY) / 2;
  const meanX = minX !== undefined && maxX !== undefined ? (minX + maxX) / 2 : undefined;

  // Swiss LV95 northings are ~1.07–1.30 Mm; eastings ~2.48–2.84 Mm.
  if (meanY > 1_000_000 && meanY < 1_400_000) {
    if (meanX === undefined || (meanX > 2_300_000 && meanX < 3_000_000)) return 'CH1903_LV95';
  }

  // NZTM2000 northings are ~4.7–6.3 Mm; eastings ~1.0–2.2 Mm.
  if (meanY > 4_500_000 && meanY < 6_500_000) {
    if (meanX !== undefined && meanX > 1_350_000 && meanX < 2_500_000) return 'NZTM2000';
  }

  // Japan Plane Rectangular CS coordinates are centered around 0 (typically between -400 km and +400 km)
  if (meanY > -500_000 && meanY < 500_000 && meanX !== undefined && meanX > -500_000 && meanX < 500_000) {
    return 'JGD2011_ZONE_09';
  }

  return meanY > 7_400_000 ? 'RGR92UTM40S' : 'LAMB93';
}

function getProj(crs: DetectedCrs): string {
  if (crs === 'RGR92UTM40S') return PROJ_UTM40S;
  if (crs === 'CH1903_LV95') return PROJ_LV95;
  if (crs === 'NZTM2000') return PROJ_NZTM2000;
  if (isJgd2011Crs(crs)) {
    const zone = parseJgd2011Zone(crs);
    return JGD2011_ZONE_DEFS[zone]?.epsg ?? 'EPSG:6677';
  }
  return PROJ_LAMB93;
}

export function toWgs84(x: number, y: number, crs: DetectedCrs): [number, number] {
  if (crs === 'CH1903_LV95') return swissToWgs84(x, y);
  if (crs === 'NZTM2000') return nzToWgs84(x, y);
  if (isJgd2011Crs(crs)) {
    const zone = parseJgd2011Zone(crs);
    return japanToWgs84(x, y, zone);
  }
  return proj4(getProj(crs), PROJ_WGS84, [x, y]) as [number, number];
}

export function fromWgs84(lon: number, lat: number, crs: DetectedCrs): [number, number] {
  if (crs === 'CH1903_LV95') return wgs84ToSwiss(lon, lat);
  if (crs === 'NZTM2000') return wgs84ToNz(lon, lat);
  if (isJgd2011Crs(crs)) {
    const zone = parseJgd2011Zone(crs);
    return wgs84ToJapan(lon, lat, zone);
  }
  return proj4(PROJ_WGS84, getProj(crs), [lon, lat]) as [number, number];
}

export function wgs84ToTile(lon: number, lat: number, zoom: number): { tx: number; ty: number } {
  const n = Math.pow(2, zoom);
  const tx = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const ty = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { tx, ty };
}

export function getTileInfo(crs: DetectedCrs): { territory: Territory; altRef: AltitudeRef } {
  if (crs === 'RGR92UTM40S') return { territory: 'REU', altRef: 'REUN89' };
  if (crs === 'CH1903_LV95') return { territory: 'CH', altRef: 'LN02' };
  if (crs === 'NZTM2000') return { territory: 'NZ', altRef: 'NZVD2016' };
  if (isJgd2011Crs(crs)) return { territory: 'JP', altRef: 'TP' };
  return { territory: 'FXX', altRef: 'IGN69' };
}

export function getTimeZoneForCoordinates(lon: number, lat: number, crs?: string): string {
  if (crs?.startsWith('JGD2011') || (lon >= 122.0 && lon <= 154.5 && lat >= 20.0 && lat <= 46.0)) {
    return 'Asia/Tokyo';
  }
  if (crs === 'NZTM2000' || (lon >= 165.0 && lon <= 180.0 && lat >= -48.0 && lat <= -33.0) || (lon >= -180.0 && lon <= -175.0 && lat >= -45.0 && lat <= -43.0)) {
    return 'Pacific/Auckland';
  }
  if (crs === 'RGR92UTM40S' || (lon >= 54.5 && lon <= 56.5 && lat >= -22.0 && lat <= -20.0)) {
    return 'Indian/Reunion';
  }
  if (lon >= 44.5 && lon <= 45.8 && lat >= -13.5 && lat <= -12.3) {
    return 'Indian/Mayotte';
  }
  if (lon >= -62.0 && lon <= -60.5 && lat >= 14.0 && lat <= 16.6) {
    return 'America/Guadeloupe';
  }
  if (lon >= -55.0 && lon <= -51.0 && lat >= 2.0 && lat <= 6.5) {
    return 'America/Cayenne';
  }
  if (crs === 'CH1903_LV95' || (lon >= 5.9 && lon <= 10.5 && lat >= 45.8 && lat <= 47.8)) {
    return 'Europe/Zurich';
  }
  return 'Europe/Paris';
}

export function isCorsica(xLamb93: number, yLamb93: number): boolean {
  return xLamb93 >= 1_100_000 && xLamb93 <= 1_300_000 &&
         yLamb93 >= 6_050_000 && yLamb93 <= 6_300_000;
}

export function formatKmCoordinate(val: number): string {
  if (val < 0) {
    return `m${String(Math.abs(val)).padStart(4, '0')}`;
  }
  return `p${String(val).padStart(4, '0')}`;
}

export function parseKmCoordinate(str: string): number {
  if (str.startsWith('m')) {
    return -parseInt(str.slice(1), 10);
  }
  if (str.startsWith('p')) {
    return parseInt(str.slice(1), 10);
  }
  return parseInt(str, 10);
}

export function buildTileFileName(xKm: number, yKm: number, crs: DetectedCrs, altRef?: AltitudeRef): string {
  const info = getTileInfo(crs);
  if (crs === 'CH1903_LV95') {
    // Swiss naming: SW corner (xKm = east km, yKm = north km).
    const x4 = String(xKm).padStart(4, '0');
    const y4 = String(yKm).padStart(4, '0');
    return `LHD_${info.territory}_${x4}_${y4}_PTS_CH1903_LV95_${altRef ?? info.altRef}`;
  }
  if (crs === 'NZTM2000') {
    // NZ naming: SW corner (xKm = east km, yKm = north km).
    const x4 = String(xKm).padStart(4, '0');
    const y4 = String(yKm).padStart(4, '0');
    return `LHD_${info.territory}_${x4}_${y4}_PTS_NZTM2000_${altRef ?? info.altRef}`;
  }
  if (isJgd2011Crs(crs)) {
    // Japan naming: SW corner with signed/formatted km coordinates
    const xEnc = formatKmCoordinate(xKm);
    const yEnc = formatKmCoordinate(yKm);
    return `LHD_${info.territory}_${xEnc}_${yEnc}_PTS_${crs}_${altRef ?? info.altRef}`;
  }
  // IGN LiDAR HD naming convention: tiles are identified by their NW corner.
  // X = west edge km (xKm), Y = north edge km (yKm + 1) since yKm is the south edge.
  const x4 = String(xKm).padStart(4, '0');
  const y4 = String(yKm + 1).padStart(4, '0');
  return `LHD_${info.territory}_${x4}_${y4}_PTS_${crs}_${altRef ?? info.altRef}`;
}

export function getTileBounds(coord: TileCoord): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return {
    minX: coord.xKm * 1000,
    minY: coord.yKm * 1000,
    maxX: (coord.xKm + 1) * 1000,
    maxY: (coord.yKm + 1) * 1000,
  };
}

export function tileCoordToWgs84Polygon(coord: TileCoord): [number, number][] {
  const { minX, minY, maxX, maxY } = getTileBounds(coord);
  const southWest = toWgs84(minX, minY, coord.projection);
  const southEast = toWgs84(maxX, minY, coord.projection);
  const northEast = toWgs84(maxX, maxY, coord.projection);
  const northWest = toWgs84(minX, maxY, coord.projection);
  return [southWest, southEast, northEast, northWest, southWest];
}

export function wgs84ToTileCoord(lon: number, lat: number): TileCoord {
  // Japan coverage check
  if (isInJapanCoverage(lon, lat)) {
    const jp = wgs84ToJapanTileCoord(lon, lat);
    const crsName = `JGD2011_ZONE_${String(jp.zone).padStart(2, '0')}` as DetectedCrs;
    const info = getTileInfo(crsName);
    return {
      xKm: jp.eastKm,
      yKm: jp.northKm,
      territory: info.territory,
      projection: crsName,
      altRef: info.altRef,
    };
  }

  // New Zealand coverage check
  if (isInNzCoverage(lon, lat)) {
    const nz = wgs84ToNzTileCoord(lon, lat);
    const info = getTileInfo('NZTM2000');
    return {
      xKm: nz.eastKm,
      yKm: nz.northKm,
      territory: info.territory,
      projection: 'NZTM2000',
      altRef: info.altRef,
    };
  }

  // Swiss coverage check
  if (isInSwissCoverage(lon, lat)) {
    const swiss = wgs84ToSwissTileCoord(lon, lat);
    const info = getTileInfo('CH1903_LV95');
    return {
      xKm: swiss.eastKm,
      yKm: swiss.northKm,
      territory: info.territory,
      projection: 'CH1903_LV95',
      altRef: info.altRef,
    };
  }

  const isReunion = lon > 55 && lon < 56 && lat > -21.5 && lat < -20.5;
  const crs: DetectedCrs = isReunion ? 'RGR92UTM40S' : 'LAMB93';

  const [x, y] = fromWgs84(lon, lat, crs);
  const xKm = Math.floor(x / 1000);
  const yKm = Math.floor(y / 1000);

  const info = getTileInfo(crs);
  const altRef = crs === 'LAMB93' && isCorsica(x, y) ? 'IGN78' : info.altRef;

  return { xKm, yKm, territory: info.territory, projection: crs, altRef };
}
