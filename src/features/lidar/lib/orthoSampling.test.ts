import { describe, expect, it } from 'vitest';
import {
  ORTHO_TILE_SIZE,
  orthoTileSlot,
  sampleOrthoColors,
  type OrthoPixelMapping,
  type OrthoTileGrid,
} from './orthoSampling';

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-sample reference: each of the four bilinear samples looks its tile up. */
function referenceColors(positions: Float32Array, count: number, m: OrthoPixelMapping, grid: OrthoTileGrid): Uint8Array {
  const colors = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const fx = (positions[i * 3]! - m.xMin) * m.invDx;
    const fy = (positions[i * 3 + 1]! - m.yMin) * m.invDy;
    const fx1 = 1 - fx;
    const fy1 = 1 - fy;
    const absPx = fx1 * fy1 * m.px00 + fx * fy1 * m.px10 + fx1 * fy * m.px01 + fx * fy * m.px11;
    const absPy = fx1 * fy1 * m.py00 + fx * fy1 * m.py10 + fx1 * fy * m.py01 + fx * fy * m.py11;
    const floorPx = absPx | 0;
    const floorPy = absPy | 0;
    const fracX = absPx - floorPx;
    const fracY = absPy - floorPy;
    const weights = [(1 - fracX) * (1 - fracY), fracX * (1 - fracY), (1 - fracX) * fracY, fracX * fracY];
    let r = 0, g = 0, b = 0, hits = 0;
    for (let s = 0; s < 4; s++) {
      const spx = floorPx + (s & 1);
      const spy = floorPy + (s >> 1);
      const slot = orthoTileSlot(spx, spy, grid.minTileCol, grid.minTileRow, grid.cols, grid.rows);
      const pixels = slot >= 0 ? grid.tiles[slot] : null;
      if (!pixels) continue;
      const p = ((spy & 255) * ORTHO_TILE_SIZE + (spx & 255)) * 4;
      r += pixels[p]! * weights[s]!;
      g += pixels[p + 1]! * weights[s]!;
      b += pixels[p + 2]! * weights[s]!;
      hits += weights[s]!;
    }
    const ci = i * 3;
    if (hits > 0) {
      const inv = 1 / hits;
      colors[ci] = (r * inv + 0.5) | 0;
      colors[ci + 1] = (g * inv + 0.5) | 0;
      colors[ci + 2] = (b * inv + 0.5) | 0;
    } else {
      colors.fill(128, ci, ci + 3);
    }
  }
  return colors;
}

describe('sampleOrthoColors', () => {
  it('matches per-sample bilinear sampling, across tile edges, missing tiles and the extent border', () => {
    const rand = mulberry32(21);
    const cols = 3;
    const rows = 4;
    const minTileCol = 265_000;
    const minTileRow = 180_000;
    const tiles = Array.from({ length: cols * rows }, (_, slot) => {
      if (slot === 5) return null; // a tile that failed to download
      const pixels = new Uint8Array(ORTHO_TILE_SIZE * ORTHO_TILE_SIZE * 4);
      for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(rand() * 256);
      return pixels;
    });
    const grid: OrthoTileGrid = { minTileCol, minTileRow, cols, rows, tiles };
    // A slightly rotated, sheared extent whose corners overhang the fetched tiles.
    const x0 = minTileCol * 256 - 40;
    const y0 = minTileRow * 256 - 30;
    const mapping: OrthoPixelMapping = {
      xMin: 0, yMin: 0, invDx: 1 / 1000, invDy: 1 / 1000,
      px00: x0, py00: y0 + rows * 256 + 50,
      px10: x0 + cols * 256 + 70, py10: y0 + rows * 256 + 20,
      px01: x0 + 15, py01: y0,
      px11: x0 + cols * 256 + 90, py11: y0 - 10,
    };
    const count = 60_000;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = rand() * 1000;
      positions[i * 3 + 1] = rand() * 1000;
      positions[i * 3 + 2] = rand() * 100;
    }
    // Points landing exactly on pixel 255 of a tile (both paths of the sampler).
    for (let i = 0; i < 2000; i++) positions[i * 3] = ((255 + 256 * (i % 3)) + 40 + rand() * 0.99) / (cols * 256 + 70) * 1000;

    const colors = new Uint8Array(count * 3);
    sampleOrthoColors(positions, colors, 0, count, mapping, grid);
    expect(colors).toEqual(referenceColors(positions, count, mapping, grid));
    // Grey where no sample has imagery (outside the tiles or on the missing one).
    let grey = 0;
    for (let i = 0; i < count; i++) if (colors[i * 3] === 128 && colors[i * 3 + 1] === 128 && colors[i * 3 + 2] === 128) grey++;
    expect(grey).toBeGreaterThan(count * 0.05);
    expect(grey).toBeLessThan(count * 0.3);
  });

  it('colours only the requested range', () => {
    const tiles = [new Uint8Array(ORTHO_TILE_SIZE * ORTHO_TILE_SIZE * 4).fill(200)];
    const grid: OrthoTileGrid = { minTileCol: 10, minTileRow: 20, cols: 1, rows: 1, tiles };
    const mapping: OrthoPixelMapping = {
      xMin: 0, yMin: 0, invDx: 1 / 10, invDy: 1 / 10,
      px00: 2600, py00: 5200, px10: 2650, py10: 5200, px01: 2600, py01: 5250, px11: 2650, py11: 5250,
    };
    const positions = new Float32Array([1, 1, 0, 5, 5, 0, 9, 9, 0]);
    const colors = new Uint8Array(9);
    sampleOrthoColors(positions, colors, 1, 2, mapping, grid);
    expect(Array.from(colors)).toEqual([0, 0, 0, 200, 200, 200, 0, 0, 0]);
  });
});
