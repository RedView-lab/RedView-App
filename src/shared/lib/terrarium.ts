// ============================================================================
// Tuiles d'altitude Terrarium (AWS Open Data, mondiales, sans clé ni quota),
// décodées dans le navigateur : altitude = R·256 + G + B/256 − 32768 (m).
// Utilisées par le modèle de neige (orographie, DEM lointain) et par le
// profil d'altitude des tracés hors de France (l'IGN couvre la France).
// ============================================================================

const TERRARIUM_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const TERRARIUM_TILE_SIZE = 256;

export function lonToTileX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 2 ** zoom;
}

export function latToTileY(lat: number, zoom: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** zoom;
}

/** Décodage navigateur disponible (OffscreenCanvas + createImageBitmap). */
export function terrariumSupported(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
}

/** Altitudes d'une tuile PNG Terrarium, 256 × 256 en ligne. */
async function decodeTerrariumTile(blob: Blob): Promise<Float32Array> {
  const size = TERRARIUM_TILE_SIZE;
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error('2D context unavailable');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const px = ctx.getImageData(0, 0, size, size).data;
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return out;
}

/** Tuile téléchargée et décodée ; `null` si elle n'existe pas (404) ou ne se décode pas. */
export async function fetchTerrariumTile(zoom: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array | null> {
  try {
    const res = await fetch(`${TERRARIUM_BASE}/${zoom}/${x}/${y}.png`, { signal });
    if (!res.ok) return null;
    return await decodeTerrariumTile(await res.blob());
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/** Altitude bilinéaire au pixel (px, py) d'une tuile, bornée à ses bords. */
export function sampleTerrariumTile(tile: Float32Array, px: number, py: number): number {
  const size = TERRARIUM_TILE_SIZE;
  const x = Math.min(size - 1.001, Math.max(0, px - 0.5));
  const y = Math.min(size - 1.001, Math.max(0, py - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const i = y0 * size + x0;
  const a = tile[i] + (tile[i + 1] - tile[i]) * tx;
  const b = tile[i + size] + (tile[i + size + 1] - tile[i + size]) * tx;
  return a + (b - a) * ty;
}

export interface TerrariumPoint {
  lat: number;
  lon: number;
}

/**
 * Altitude de chaque point, lue sur les tuiles du niveau `zoom` (z12 ≈ 27 m
 * par pixel à 45° de latitude). Chaque tuile n'est téléchargée qu'une fois ;
 * au-delà de `maxTiles` tuiles distinctes, les points restants sont `null`
 * (l'appelant garde l'altitude qu'il avait). `null` aussi pour une tuile
 * absente ou une valeur hors plage.
 */
export async function sampleTerrariumElevations(
  points: readonly TerrariumPoint[],
  { zoom = 12, maxTiles = 400, concurrency = 6, signal }: { zoom?: number; maxTiles?: number; concurrency?: number; signal?: AbortSignal } = {},
): Promise<Array<number | null>> {
  const out: Array<number | null> = new Array(points.length).fill(null);
  if (points.length === 0 || !terrariumSupported()) return out;

  const byTile = new Map<string, { x: number; y: number; indexes: number[] }>();
  points.forEach((point, index) => {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 85) return;
    const x = Math.floor(lonToTileX(point.lon, zoom));
    const y = Math.floor(latToTileY(point.lat, zoom));
    const key = `${x}/${y}`;
    const entry = byTile.get(key);
    if (entry) entry.indexes.push(index);
    else if (byTile.size < maxTiles) byTile.set(key, { x, y, indexes: [index] });
  });

  const queue = [...byTile.values()];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const tile = await fetchTerrariumTile(zoom, job.x, job.y, signal);
      if (!tile) continue;
      for (const index of job.indexes) {
        const point = points[index];
        const px = (lonToTileX(point.lon, zoom) - job.x) * TERRARIUM_TILE_SIZE;
        const py = (latToTileY(point.lat, zoom) - job.y) * TERRARIUM_TILE_SIZE;
        const elevation = sampleTerrariumTile(tile, px, py);
        out[index] = Number.isFinite(elevation) && elevation > -500 && elevation < 9000 ? elevation : null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}
