/**
 * Polygon rasterization mask for the analysis zone, used by the sunlight
 * workers (cast-shadow image + cumulative sunshine map) to trim their PNG
 * output to the user-drawn polygon.
 *
 * Projection matches the elevation-grid sampling in dem-grid-worker.ts /
 * shadowWorker.ts: columns linear in longitude, rows linear in MERCATOR-Y —
 * NOT linear in latitude. Using the same mapping keeps the mask perfectly
 * registered with the colorized grid.
 *
 * 2× supersampled scanline fill + 2×2 box downsample = ~1 cell feathered
 * edge (no aliasing against the terrain overlay).
 */

export type MaskBounds = [number, number, number, number];

function mercY(latDeg: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, latDeg));
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}

/**
 * @param flatRing [lng, lat, lng, lat, …] polygon ring (closed or open).
 * @param bounds   Sampled grid bounds [west, south, east, north].
 * @param w        Grid width in cells.
 * @param h        Grid height in cells.
 * @returns w×h mask (255 inside, 0 outside, feathered boundary) or null when
 *          the ring is degenerate / wholly outside the bounds.
 */
export function rasterizePolygonMask(
  flatRing: readonly number[],
  bounds: MaskBounds,
  w: number,
  h: number,
): Uint8Array | null {
  if (!Array.isArray(flatRing) || flatRing.length < 6 || w <= 0 || h <= 0) return null;
  const [west, south, east, north] = bounds;
  const spanX = east - west;
  const nMercY = mercY(north);
  const sMercY = mercY(south);
  const spanY = sMercY - nMercY;
  if (spanX <= 0 || spanY <= 0) return null;

  const count = Math.floor(flatRing.length / 2);
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const lng = flatRing[i * 2];
    const lat = flatRing[i * 2 + 1];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    px[i] = ((lng - west) / spanX) * w;
    py[i] = ((mercY(lat) - nMercY) / spanY) * h;
  }

  // 2× supersampled coverage buffer.
  const ss = 2;
  const sw = w * ss;
  const sh = h * ss;
  const mask = new Uint8Array(sw * sh);
  const xs: number[] = [];
  for (let row = 0; row < sh; row++) {
    const sy = row + 0.5;
    xs.length = 0;
    for (let e = 0; e < count; e++) {
      const i1 = (e + 1) % count;
      const y0 = py[e];
      const y1 = py[i1];
      if ((sy >= y0 && sy < y1) || (sy >= y1 && sy < y0)) {
        const t = (sy - y0) / (y1 - y0);
        xs.push(px[e] + t * (px[i1] - px[e]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const rowBase = row * sw;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const cx0 = Math.max(0, Math.ceil(xs[k] * ss));
      const cx1 = Math.min(sw - 1, Math.floor(xs[k + 1] * ss));
      for (let cx = cx0; cx <= cx1; cx++) mask[rowBase + cx] = 255;
    }
  }

  // 2×2 average downsample → feathered alpha.
  const out = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    const sRow = r * ss * sw;
    const oRow = r * w;
    for (let c = 0; c < w; c++) {
      const s0 = sRow + c * ss;
      out[oRow + c] = (mask[s0] + mask[s0 + 1] + mask[s0 + sw] + mask[s0 + sw + 1]) >> 2;
    }
  }
  return out;
}

/** Applies the mask to a straight RGBA buffer's alpha channel. */
export function applyPolygonMaskToRgba(rgba: Uint8Array, mask: Uint8Array): void {
  const n = mask.length;
  for (let j = 0; j < n; j++) {
    const m = mask[j];
    if (m >= 255) continue;
    const idx = j * 4;
    if (m === 0) {
      rgba[idx + 3] = 0;
    } else {
      rgba[idx + 3] = ((rgba[idx + 3] * m) + 127) >> 8;
    }
  }
}
