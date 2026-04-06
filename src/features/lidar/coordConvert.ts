import proj4 from 'proj4';
import type { DetectedCrs, Territory, AltitudeRef, TileCoord } from './types';

// Register Lambert93 (EPSG:2154)
proj4.defs('EPSG:2154', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');

// Register RGR92 / UTM 40S (EPSG:2975) — Réunion
proj4.defs('EPSG:2975', '+proj=utm +zone=40 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');

const PROJ_LAMB93 = 'EPSG:2154';
const PROJ_UTM40S = 'EPSG:2975';
const PROJ_WGS84 = 'EPSG:4326';

export function detectCrs(minY: number, maxY: number): DetectedCrs {
  const meanY = (minY + maxY) / 2;
  return meanY > 7_400_000 ? 'RGR92UTM40S' : 'LAMB93';
}

function getProj(crs: DetectedCrs): string {
  return crs === 'RGR92UTM40S' ? PROJ_UTM40S : PROJ_LAMB93;
}

export function toWgs84(x: number, y: number, crs: DetectedCrs): [number, number] {
  return proj4(getProj(crs), PROJ_WGS84, [x, y]) as [number, number];
}

export function fromWgs84(lon: number, lat: number, crs: DetectedCrs): [number, number] {
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
  if (crs === 'RGR92UTM40S') {
    return { territory: 'REU', altRef: 'REUN89' };
  }
  return { territory: 'FXX', altRef: 'IGN69' };
}

export function isCorsica(xLamb93: number, yLamb93: number): boolean {
  return xLamb93 >= 1_100_000 && xLamb93 <= 1_300_000 &&
         yLamb93 >= 6_050_000 && yLamb93 <= 6_300_000;
}

export function buildTileFileName(xKm: number, yKm: number, crs: DetectedCrs, altRef?: AltitudeRef): string {
  const info = getTileInfo(crs);
  const x4 = String(xKm).padStart(4, '0');
  const y4 = String(yKm).padStart(4, '0');
  return `LHD_${info.territory}_${x4}_${y4}_PTS_${crs}_${altRef ?? info.altRef}`;
}

export function wgs84ToTileCoord(lon: number, lat: number): TileCoord {
  const isReunion = lon > 55 && lon < 56 && lat > -21.5 && lat < -20.5;
  const crs: DetectedCrs = isReunion ? 'RGR92UTM40S' : 'LAMB93';

  const [x, y] = fromWgs84(lon, lat, crs);
  const xKm = Math.floor(x / 1000);
  const yKm = Math.floor(y / 1000);

  const info = getTileInfo(crs);
  const altRef = crs === 'LAMB93' && isCorsica(x, y) ? 'IGN78' : info.altRef;

  return { xKm, yKm, territory: info.territory, projection: crs, altRef };
}
