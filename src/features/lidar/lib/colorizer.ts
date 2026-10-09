import type { PointCloudData, DetectedCrs } from '../types';
import { toWgs84, isJgd2011Crs } from './coordConvert';
import { fetchLinzImageryTile, linzBasemapsApiKey } from './nz/linzImagery';
import { beneluxOrthoTileUrl } from './beneluxOrtho';
import { fillDefaultOrthoColors, ORTHO_TILE_SIZE as TILE_SIZE, sampleOrthoColors } from './orthoSampling';

const WMTS_ZOOM = 19;

// IGN — Géoplateforme orthophotos (France).
const IGN_ORTHO_URL = (z: number, x: number, y: number) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;

// swisstopo — SWISSIMAGE (Suisse). WMTS public, CORS activé, sans clé.
// Le jeu de matrices 3857 utilise la même grille de tuiles Web Mercator que
// IGN PM, donc le calcul wgs84→pixel existant (`wgs84ToAbsPixel`) marche tel quel.
// Les sous-domaines wmts0..9 sont répartis : on en choisit un par tuile pour étaler la charge.
const SWISS_ORTHO_URL = (z: number, x: number, y: number) => {
  const sub = (x + y) % 10;
  return `https://wmts${sub}.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/${z}/${x}/${y}.jpeg`;
};

// Nouvelle-Zélande : imagerie aérienne LINZ Basemaps via `fetchLinzImageryTile`
// (clé d'API de la build, voir nz/linzImagery.ts).
function orthoUrlForCrs(crs: DetectedCrs, z: number, x: number, y: number): string {
  if (crs === 'CH1903_LV95') return SWISS_ORTHO_URL(z, x, y);
  return beneluxOrthoTileUrl(crs, z, x, y) ?? IGN_ORTHO_URL(z, x, y);
}

async function fetchOrthoBitmap(crs: DetectedCrs, z: number, x: number, y: number): Promise<ImageBitmap | null> {
  if (crs === 'NZTM2000') return fetchLinzImageryTile(z, x, y);
  const response = await fetch(orthoUrlForCrs(crs, z, x, y));
  if (!response.ok) return null;
  return createImageBitmap(await response.blob());
}

/** `false` quand l'orthophoto du territoire n'est pas disponible dans cette build. */
function hasOrthoSource(crs: DetectedCrs): boolean {
  return crs !== 'NZTM2000' || linzBasemapsApiKey() !== null;
}

let _sharedOrthoCanvas: OffscreenCanvas | null = null;
let _sharedOrthoCtx: OffscreenCanvasRenderingContext2D | null = null;

function getSharedOrthoCtx(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (!_sharedOrthoCanvas) {
    _sharedOrthoCanvas = new OffscreenCanvas(width, height);
    _sharedOrthoCtx = _sharedOrthoCanvas.getContext('2d', {
      willReadFrequently: true,
    }) as OffscreenCanvasRenderingContext2D;
  } else if (_sharedOrthoCanvas.width !== width || _sharedOrthoCanvas.height !== height) {
    _sharedOrthoCanvas.width = width;
    _sharedOrthoCanvas.height = height;
    _sharedOrthoCtx = _sharedOrthoCanvas.getContext('2d', {
      willReadFrequently: true,
    }) as OffscreenCanvasRenderingContext2D;
  }
  return _sharedOrthoCtx!;
}

async function fetchOrthoTile(
  zoom: number,
  tileX: number,
  tileY: number,
  crs: DetectedCrs,
): Promise<Uint8Array | null> {
  try {
    if (isJgd2011Crs(crs)) {
      // GSI (Geospatial Information Authority of Japan / 国土地理院) — orthophotos continues
      const gsiCol = tileX >> (zoom - 18);
      const gsiRow = tileY >> (zoom - 18);
      const subX = (tileX & 1) * 128;
      const subY = (tileY & 1) * 128;
      const gsiUrl = `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/18/${gsiCol}/${gsiRow}.jpg`;
      const response = await fetch(gsiUrl);
      if (response.ok) {
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        const ctx = getSharedOrthoCtx(TILE_SIZE, TILE_SIZE);
        ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
        ctx.drawImage(bitmap, subX, subY, 128, 128, 0, 0, TILE_SIZE, TILE_SIZE);
        const imgData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
        bitmap.close();
        return new Uint8Array(imgData.data.buffer.slice(0));
      }
    }

    const bitmap = await fetchOrthoBitmap(crs, zoom, tileX, tileY);
    if (!bitmap) return null;
    const ctx = getSharedOrthoCtx(TILE_SIZE, TILE_SIZE);
    ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    ctx.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
    const imgData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
    bitmap.close();
    return new Uint8Array(imgData.data.buffer.slice(0));
  } catch {
    return null;
  }
}

function wgs84ToAbsPixel(lon: number, lat: number, zoom: number): [number, number] {
  const n = Math.pow(2, zoom);
  const absPx = ((lon + 180) / 360) * n * TILE_SIZE;
  const latRad = (lat * Math.PI) / 180;
  const absPy = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * TILE_SIZE;
  return [absPx, absPy];
}

const ORTHO_FETCH_CONCURRENCY = 48;

// Cache par worker des tuiles ortho en cours de téléchargement ou décodées :
// un préchargement lancé depuis l'emprise de l'en-tête COPC (pendant que les
// points se décodent encore) est réutilisé par la passe de colorisation.
const orthoTileCache = new Map<string, Promise<Uint8Array | null>>();
const orthoFetchQueue: Array<() => void> = [];
let orthoFetchesInFlight = 0;

function runOrthoFetchQueue(): void {
  while (orthoFetchesInFlight < ORTHO_FETCH_CONCURRENCY && orthoFetchQueue.length > 0) {
    orthoFetchesInFlight++;
    orthoFetchQueue.shift()!();
  }
}

function getOrthoTile(zoom: number, tileX: number, tileY: number, crs: DetectedCrs): Promise<Uint8Array | null> {
  const key = `${crs}/${zoom}/${tileX}/${tileY}`;
  let pending = orthoTileCache.get(key);
  if (!pending) {
    pending = new Promise<Uint8Array | null>((resolve) => {
      orthoFetchQueue.push(() => {
        fetchOrthoTile(zoom, tileX, tileY, crs)
          .then(resolve, () => resolve(null))
          .finally(() => {
            orthoFetchesInFlight--;
            runOrthoFetchQueue();
          });
      });
      runOrthoFetchQueue();
    });
    orthoTileCache.set(key, pending);
  }
  return pending;
}

interface OrthoTileRange {
  px00: number; py00: number;
  px10: number; py10: number;
  px01: number; py01: number;
  px11: number; py11: number;
  minTileCol: number; maxTileCol: number;
  minTileRow: number; maxTileRow: number;
}

function computeOrthoTileRange(bounds: PointCloudData['bounds'], crs: DetectedCrs): OrthoTileRange {
  const [lon00, lat00] = toWgs84(bounds.minX, bounds.minY, crs);
  const [lon10, lat10] = toWgs84(bounds.maxX, bounds.minY, crs);
  const [lon01, lat01] = toWgs84(bounds.minX, bounds.maxY, crs);
  const [lon11, lat11] = toWgs84(bounds.maxX, bounds.maxY, crs);

  const [px00, py00] = wgs84ToAbsPixel(lon00, lat00, WMTS_ZOOM);
  const [px10, py10] = wgs84ToAbsPixel(lon10, lat10, WMTS_ZOOM);
  const [px01, py01] = wgs84ToAbsPixel(lon01, lat01, WMTS_ZOOM);
  const [px11, py11] = wgs84ToAbsPixel(lon11, lat11, WMTS_ZOOM);

  const allPxX = [px00, px10, px01, px11];
  const allPxY = [py00, py10, py01, py11];
  return {
    px00, py00, px10, py10, px01, py01, px11, py11,
    minTileCol: Math.floor(Math.min(...allPxX) / TILE_SIZE),
    maxTileCol: Math.floor(Math.max(...allPxX) / TILE_SIZE),
    minTileRow: Math.floor(Math.min(...allPxY) / TILE_SIZE),
    maxTileRow: Math.floor(Math.max(...allPxY) / TILE_SIZE),
  };
}

/**
 * Lance le téléchargement des tuiles ortho couvrant `bounds` (en général
 * l'emprise de l'en-tête COPC) sans les attendre. `colorizePointCloud` les reprend.
 */
export function prefetchOrthoTiles(bounds: PointCloudData['bounds'], crs: DetectedCrs): void {
  if (!hasOrthoSource(crs)) return;
  const range = computeOrthoTileRange(bounds, crs);
  for (let col = range.minTileCol; col <= range.maxTileCol; col++) {
    for (let row = range.minTileRow; row <= range.maxTileRow; row++) {
      void getOrthoTile(WMTS_ZOOM, col, row, crs);
    }
  }
}

export async function colorizePointCloud(
  pointCloud: PointCloudData,
  onProgress?: (phase: string, percent: number) => void
): Promise<void> {
  const { positions, colors, count, crs, bounds, origin } = pointCloud;

  // Sans source d'orthophoto (Nouvelle-Zélande sans clé LINZ), aucune
  // requête : tous les points prennent le gris par défaut.
  if (!hasOrthoSource(crs)) {
    fillDefaultOrthoColors(colors, count);
    onProgress?.('Colorisation terminée', 100);
    return;
  }

  const {
    px00, py00, px10, py10, px01, py01, px11, py11,
    minTileCol, maxTileCol, minTileRow, maxTileRow,
  } = computeOrthoTileRange(bounds, crs);

  const invDx = 1 / (bounds.maxX - bounds.minX);
  const invDy = 1 / (bounds.maxY - bounds.minY);
  // Les positions sont relatives à `origin` : exprimer l'emprise dans le même repère.
  const xMin = bounds.minX - origin.x;
  const yMin = bounds.minY - origin.y;

  onProgress?.('Téléchargement des orthophotos...', 0);

  const tileCols = maxTileCol - minTileCol + 1;
  const tileRows = maxTileRow - minTileRow + 1;
  const tileData: (Uint8Array | null)[] = new Array(tileCols * tileRows).fill(null);

  const tileJobs: Promise<void>[] = [];
  let tilesDone = 0;
  const totalTiles = tileCols * tileRows;
  for (let col = minTileCol; col <= maxTileCol; col++) {
    for (let row = minTileRow; row <= maxTileRow; row++) {
      const idx = (col - minTileCol) * tileRows + (row - minTileRow);
      tileJobs.push(getOrthoTile(WMTS_ZOOM, col, row, crs).then((pixels) => {
        tileData[idx] = pixels;
        tilesDone++;
        if (tilesDone % 24 === 0 || tilesDone === totalTiles) {
          onProgress?.('Téléchargement des orthophotos...', Math.round((tilesDone / totalTiles) * 50));
        }
      }));
    }
  }
  await Promise.all(tileJobs);
  orthoTileCache.clear();

  onProgress?.('Colorisation des points...', 50);

  const CHUNK = 1_000_000;
  const totalChunks = Math.ceil(count / CHUNK);
  const mapping = { xMin, yMin, invDx, invDy, px00, py00, px10, py10, px01, py01, px11, py11 };
  const grid = { minTileCol, minTileRow, cols: tileCols, rows: tileRows, tiles: tileData };

  for (let chunk = 0; chunk < totalChunks; chunk++) {
    const start = chunk * CHUNK;
    sampleOrthoColors(positions, colors, start, Math.min(start + CHUNK, count), mapping, grid);

    const progress = 50 + Math.round(((chunk + 1) / totalChunks) * 50);
    onProgress?.('Colorisation des points...', progress);

    if (chunk < totalChunks - 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  onProgress?.('Colorisation terminée', 100);
}
