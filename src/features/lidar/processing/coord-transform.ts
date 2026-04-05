import proj4 from 'proj4';
import type { DetectedCrs, Territory, AltitudeRef, TileCoord } from '../types/geometry';

proj4.defs('EPSG:2154', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');
proj4.defs('EPSG:2975', '+proj=utm +zone=40 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');

const LAMB93 = 'EPSG:2154';
const UTM40S = 'EPSG:2975';
const WGS84 = 'EPSG:4326';

const UTM40S_Y_THRESHOLD = 7_400_000;

const CORSICA_BOUNDS = {
  xMin: 1_100_000,
  xMax: 1_300_000,
  yMin: 6_050_000,
  yMax: 6_300_000,
};

export function detectCrs(yMean: number): DetectedCrs {
  return yMean > UTM40S_Y_THRESHOLD ? 'RGR92UTM40S' : 'LAMB93';
}

export function detectTerritory(crs: DetectedCrs): Territory {
  return crs === 'RGR92UTM40S' ? 'REU' : 'FXX';
}

export function detectAltRef(crs: DetectedCrs, x: number, y: number): AltitudeRef {
  if (crs === 'RGR92UTM40S') return 'REUN89';
  if (isCorsica(x, y)) return 'IGN78';
  return 'IGN69';
}

export function isCorsica(x: number, y: number): boolean {
  return (
    x >= CORSICA_BOUNDS.xMin &&
    x <= CORSICA_BOUNDS.xMax &&
    y >= CORSICA_BOUNDS.yMin &&
    y <= CORSICA_BOUNDS.yMax
  );
}

function crsToEpsg(crs: DetectedCrs): string {
  return crs === 'RGR92UTM40S' ? UTM40S : LAMB93;
}

export function toWgs84(x: number, y: number, crs: DetectedCrs): [number, number] {
  const [lon, lat] = proj4(crsToEpsg(crs), WGS84, [x, y]);
  return [lon, lat];
}

export function fromWgs84(lon: number, lat: number, crs: DetectedCrs): [number, number] {
  const [x, y] = proj4(WGS84, crsToEpsg(crs), [lon, lat]);
  return [x, y];
}

export function toMercator(x: number, y: number, crs: DetectedCrs): [number, number] {
  const [lon, lat] = toWgs84(x, y, crs);
  const mx = lon / 360 + 0.5;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const my = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return [mx, my];
}

export function wgs84ToTile(lon: number, lat: number, zoom: number): { col: number; row: number } {
  const n = 2 ** zoom;
  const col = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const row = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { col, row };
}

export function pixelInTile(
  lon: number,
  lat: number,
  zoom: number,
  tileSize: number,
): { tileCol: number; tileRow: number; px: number; py: number } {
  const n = 2 ** zoom;
  const xFrac = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileCol = Math.floor(xFrac);
  const tileRow = Math.floor(yFrac);
  const px = (xFrac - tileCol) * tileSize;
  const py = (yFrac - tileRow) * tileSize;
  return { tileCol, tileRow, px, py };
}

export function buildTileFileName(coord: TileCoord): string {
  const xStr = String(coord.xKm).padStart(4, '0');
  const yStr = String(coord.yKm).padStart(4, '0');
  const terr = coord.territory;
  const proj = coord.projection === 'LAMB93' ? 'LAMB93' : 'RGR92UTM40S';
  const alt = coord.altRef;
  return `LHD_${terr}_${xStr}_${yStr}_PTS_${proj}_${alt}`;
}

export function parseTileFileName(fileName: string): TileCoord | null {
  const match = fileName.match(
    /^LHD_(FXX|REU)_(\d{4})_(\d{4})_PTS_(LAMB93|RGR92UTM40S)_(IGN69|IGN78|REUN89)/,
  );
  if (!match) return null;
  return {
    territory: match[1] as Territory,
    xKm: parseInt(match[2], 10),
    yKm: parseInt(match[3], 10),
    projection: match[4] as DetectedCrs,
    altRef: match[5] as AltitudeRef,
  };
}

export function tileCoordKey(coord: TileCoord): string {
  return `${coord.territory}_${coord.xKm}_${coord.yKm}`;
}

export function tileCenterWgs84(coord: TileCoord): [number, number] {
  const x = coord.xKm * 1000 + 500;
  const y = coord.yKm * 1000 + 500;
  return toWgs84(x, y, coord.projection);
}
