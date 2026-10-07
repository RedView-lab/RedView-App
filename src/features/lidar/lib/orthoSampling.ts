// Orthophoto sampling of point colours (pure: no DOM, no network), used by
// `colorizePointCloud` once the WMTS tiles of the tile extent are decoded.

export const ORTHO_TILE_SIZE = 256;
const DEFAULT_GREY = 128;

/** Decoded RGBA tiles of the extent, column-major: slot = col · rows + row. */
export interface OrthoTileGrid {
  minTileCol: number;
  minTileRow: number;
  cols: number;
  rows: number;
  tiles: ReadonlyArray<Uint8Array | null>;
}

/**
 * Point (relative to the cloud origin) → absolute WMTS pixel: bilinear
 * interpolation of the pixel positions of the extent's four corners.
 */
export interface OrthoPixelMapping {
  xMin: number;
  yMin: number;
  invDx: number;
  invDy: number;
  px00: number; py00: number;
  px10: number; py10: number;
  px01: number; py01: number;
  px11: number; py11: number;
}

/**
 * Slot in the column-major ortho tile array of the tile holding an absolute
 * pixel, or -1 outside the fetched range. Checking col and row separately
 * matters: a flat bound on `col·rows + row` let a row one past the last wrap
 * onto the first tile of the next column.
 */
export function orthoTileSlot(absPx: number, absPy: number, minCol: number, minRow: number, cols: number, rows: number): number {
  const col = (absPx >> 8) - minCol;
  const row = (absPy >> 8) - minRow;
  return col >= 0 && col < cols && row >= 0 && row < rows ? col * rows + row : -1;
}

/**
 * Colours points [start, end) by bilinear sampling of the ortho tiles;
 * samples outside the fetched tiles are left out of the weights, and a point
 * with none gets mid-grey. When the 2×2 footprint lies in one tile (all but
 * the last row/column of each tile's pixels) the tile is looked up once: same
 * arithmetic in the same order, so the same bytes as the per-sample path.
 */
export function sampleOrthoColors(
  positions: Float32Array,
  colors: Uint8Array,
  start: number,
  end: number,
  mapping: OrthoPixelMapping,
  grid: OrthoTileGrid,
): void {
  const { xMin, yMin, invDx, invDy, px00, py00, px10, py10, px01, py01, px11, py11 } = mapping;
  const { minTileCol, minTileRow, cols, rows, tiles } = grid;
  const rowStride = ORTHO_TILE_SIZE * 4;

  for (let i = start; i < end; i++) {
    const fx = (positions[i * 3]! - xMin) * invDx;
    const fy = (positions[i * 3 + 1]! - yMin) * invDy;
    const fx1 = 1 - fx;
    const fy1 = 1 - fy;

    const absPx = fx1 * fy1 * px00 + fx * fy1 * px10 + fx1 * fy * px01 + fx * fy * px11;
    const absPy = fx1 * fy1 * py00 + fx * fy1 * py10 + fx1 * fy * py01 + fx * fy * py11;

    const floorPx = absPx | 0;
    const floorPy = absPy | 0;
    const fracX = absPx - floorPx;
    const fracY = absPy - floorPy;

    const w00 = (1 - fracX) * (1 - fracY);
    const w10 = fracX * (1 - fracY);
    const w01 = (1 - fracX) * fracY;
    const w11 = fracX * fracY;

    let r = 0, g = 0, b = 0, hits = 0;
    const localX = floorPx & 255;
    const localY = floorPy & 255;

    if (localX !== 255 && localY !== 255) {
      const slot = orthoTileSlot(floorPx, floorPy, minTileCol, minTileRow, cols, rows);
      const pixels = slot >= 0 ? tiles[slot] : null;
      if (pixels) {
        const p = (localY * ORTHO_TILE_SIZE + localX) * 4;
        const q = p + rowStride;
        r += pixels[p]! * w00; g += pixels[p + 1]! * w00; b += pixels[p + 2]! * w00; hits += w00;
        r += pixels[p + 4]! * w10; g += pixels[p + 5]! * w10; b += pixels[p + 6]! * w10; hits += w10;
        r += pixels[q]! * w01; g += pixels[q + 1]! * w01; b += pixels[q + 2]! * w01; hits += w01;
        r += pixels[q + 4]! * w11; g += pixels[q + 5]! * w11; b += pixels[q + 6]! * w11; hits += w11;
      }
    } else {
      for (let s = 0; s < 4; s++) {
        const spx = floorPx + (s & 1);
        const spy = floorPy + (s >> 1);
        const slot = orthoTileSlot(spx, spy, minTileCol, minTileRow, cols, rows);
        const pixels = slot >= 0 ? tiles[slot] : null;
        if (!pixels) continue;
        const w = s === 0 ? w00 : s === 1 ? w10 : s === 2 ? w01 : w11;
        const p = ((spy & 255) * ORTHO_TILE_SIZE + (spx & 255)) * 4;
        r += pixels[p]! * w;
        g += pixels[p + 1]! * w;
        b += pixels[p + 2]! * w;
        hits += w;
      }
    }

    const ci = i * 3;
    if (hits > 0) {
      const inv = 1 / hits;
      colors[ci] = (r * inv + 0.5) | 0;
      colors[ci + 1] = (g * inv + 0.5) | 0;
      colors[ci + 2] = (b * inv + 0.5) | 0;
    } else {
      colors[ci] = DEFAULT_GREY;
      colors[ci + 1] = DEFAULT_GREY;
      colors[ci + 2] = DEFAULT_GREY;
    }
  }
}
