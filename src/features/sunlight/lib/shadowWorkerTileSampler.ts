import { lngLatToMercTile } from './shadowWorkerEncoding';

export const DEM_TILE_SIZE = 256;
export const DEM_NODATA_THRESHOLD = -10000;

export interface TileCoverage {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  tileCount: number;
}

export function getTileCoverage(
  bounds: [number, number, number, number],
  zoom: number,
): TileCoverage {
  const [w, s, e, n] = bounds;
  const tlTile = lngLatToMercTile(w, n, zoom);
  const brTile = lngLatToMercTile(e, s, zoom);
  const xMin = Math.floor(tlTile.x);
  const xMax = Math.floor(brTile.x);
  const yMin = Math.floor(tlTile.y);
  const yMax = Math.floor(brTile.y);
  return {
    xMin,
    xMax,
    yMin,
    yMax,
    tileCount: (xMax - xMin + 1) * (yMax - yMin + 1),
  };
}

export async function loadTileWithParents(
  cache: Cache,
  z: number,
  x: number,
  y: number,
): Promise<{
  leafX: number;
  leafY: number;
  dataX: number;
  dataY: number;
  dataZ: number;
  elev: Float32Array | null;
}> {
  if (x < 0 || y < 0 || x >= 1 << z || y >= 1 << z) {
    return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev: null };
  }

  const url = new URL(`/dem-tiles/${z}/${x}/${y}`, self.location.origin).toString();
  const direct = await cacheMatchAny(cache, url);
  if (direct) {
    const elev = await safeDecode(direct);
    if (elev) return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev };
  }

  const MAX_PARENT_WALK = 4;
  for (let dz = 1; dz <= MAX_PARENT_WALK && z - dz >= 0; dz++) {
    const pz = z - dz;
    const px = x >> dz;
    const py = y >> dz;
    const parentUrl = new URL(`/dem-tiles/${pz}/${px}/${py}`, self.location.origin).toString();
    const parent = await cacheMatchAny(cache, parentUrl);
    if (parent) {
      const elev = await safeDecode(parent);
      if (elev) return { leafX: x, leafY: y, dataX: px, dataY: py, dataZ: pz, elev };
    }
  }

  try {
    const resp = await fetch(url);
    if (resp && resp.status === 200) {
      const elev = await safeDecode(resp);
      if (elev) return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev };
    }
  } catch {
    /* ignore fetch error */
  }
  return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev: null };
}

export async function cacheMatchAny(cache: Cache, url: string): Promise<Response | null> {
  try {
    const resp = await cache.match(url, { ignoreSearch: true });
    if (resp && resp.status === 200) return resp;
  } catch {
    /* ignore */
  }
  return null;
}

export async function safeDecode(resp: Response): Promise<Float32Array | null> {
  try {
    const blob = await resp.clone().blob();
    const elev = await decodeTerrainRGB(blob);
    return elev.length === DEM_TILE_SIZE * DEM_TILE_SIZE ? elev : null;
  } catch {
    return null;
  }
}

export async function decodeTerrainRGB(blob: Blob): Promise<Float32Array> {
  const img = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const w = img.width;
  const h = img.height;
  if (w === 0 || h === 0) {
    img.close();
    return new Float32Array(0);
  }
  let imageData: ImageData;
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' }) as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    imageData = ctx.getImageData(0, 0, w, h);
  } finally {
    img.close();
  }
  const px = imageData.data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = -10000 + (px[o]! * 65536 + px[o + 1]! * 256 + px[o + 2]!) * 0.1;
  }
  return out;
}

export function bilinearSample(
  src: Float32Array,
  W: number,
  H: number,
  x: number,
  y: number,
): number {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = src[y0 * W + x0]!;
  const b = src[y0 * W + x1]!;
  const c = src[y1 * W + x0]!;
  const d = src[y1 * W + x1]!;
  if (
    a <= DEM_NODATA_THRESHOLD || b <= DEM_NODATA_THRESHOLD ||
    c <= DEM_NODATA_THRESHOLD || d <= DEM_NODATA_THRESHOLD
  ) {
    return NaN;
  }
  return (
    a * (1 - fx) * (1 - fy) +
    b * fx * (1 - fy) +
    c * (1 - fx) * fy +
    d * fx * fy
  );
}
