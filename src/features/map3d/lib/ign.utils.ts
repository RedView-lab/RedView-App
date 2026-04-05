import {
  IGN_WMTS_BASE,
  IGN_ORTHO_TILEMATRIXSET,
  IGN_DEM_TILEMATRIXSET,
  IGN_DEM_FORMAT,
  IGN_LAYERS,
} from './ign.config';

// ---------- WMTS URL builders ----------

function buildWMTSTileURL(
  layer: string,
  format: string,
  tileMatrixSet: string,
  z: number,
  col: number,
  row: number,
): string {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${layer}&STYLE=normal` +
    `&FORMAT=${encodeURIComponent(format)}` +
    `&TILEMATRIXSET=${tileMatrixSet}` +
    `&TILEMATRIX=${z}&TILEROW=${row}&TILECOL=${col}`
  );
}

export function buildDEMTileURL(z: number, col: number, row: number): string {
  return buildWMTSTileURL(
    IGN_LAYERS.ELEVATION_MNS,
    IGN_DEM_FORMAT,
    IGN_DEM_TILEMATRIXSET,
    z,
    col,
    row,
  );
}

export function getOrthoTileTemplate(): string {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_LAYERS.ORTHOPHOTO}&STYLE=normal&FORMAT=image%2Fjpeg` +
    `&TILEMATRIXSET=${IGN_ORTHO_TILEMATRIXSET}` +
    `&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`
  );
}

// ---------- Coordinate conversions ----------

/** Get lat/lng bounds of a Web Mercator (XYZ) tile. */
export function mercatorTileBounds(z: number, x: number, y: number) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  const s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);

  return {
    west: (x / (1 << z)) * 360 - 180,
    east: ((x + 1) / (1 << z)) * 360 - 180,
    north: (Math.atan(Math.sinh(n)) * 180) / Math.PI,
    south: (Math.atan(Math.sinh(s)) * 180) / Math.PI,
  };
}

/** Convert lng/lat to WGS84G tile col/row at a given zoom. */
export function lngLatToWGS84GTile(lng: number, lat: number, z: number) {
  const matrixWidth = 1 << (z + 1);
  const matrixHeight = 1 << z;

  const col = Math.floor(((lng + 180) / 360) * matrixWidth);
  const row = Math.floor(((90 - lat) / 180) * matrixHeight);

  return {
    col: Math.max(0, Math.min(col, matrixWidth - 1)),
    row: Math.max(0, Math.min(row, matrixHeight - 1)),
  };
}

/** Mercator Y-fraction → latitude (degrees). */
export function mercatorYToLat(yFrac: number): number {
  const mercY = Math.PI * (1 - 2 * yFrac);
  return (Math.atan(Math.sinh(mercY)) * 180) / Math.PI;
}
