import { describe, it, expect } from 'vitest';
import {
  TERRARIUM_TILE_SIZE,
  latToTileY,
  lonToTileX,
  sampleTerrariumElevations,
  sampleTerrariumTile,
} from './terrarium';

describe('terrarium tiles', () => {
  it('maps WGS84 to Web Mercator tile coordinates', () => {
    expect(lonToTileX(-180, 3)).toBe(0);
    expect(lonToTileX(0, 3)).toBe(4);
    expect(latToTileY(0, 3)).toBeCloseTo(4, 10);
    // Chamonix at z12: tile 2126/1458.
    expect(Math.floor(lonToTileX(6.87, 12))).toBe(2126);
    expect(Math.floor(latToTileY(45.92, 12))).toBe(1458);
  });

  it('interpolates bilinearly between pixel centres and clamps at the edges', () => {
    const size = TERRARIUM_TILE_SIZE;
    // Altitude = 10 × column + row: a plane, so bilinear sampling is exact.
    const tile = new Float32Array(size * size);
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) tile[row * size + col] = 10 * col + row;
    expect(sampleTerrariumTile(tile, 10.5, 20.5)).toBeCloseTo(10 * 10 + 20, 4);
    expect(sampleTerrariumTile(tile, 11, 21)).toBeCloseTo(10 * 10.5 + 20.5, 4);
    expect(sampleTerrariumTile(tile, -5, -5)).toBeCloseTo(0, 4);
    expect(sampleTerrariumTile(tile, size + 5, size + 5)).toBeCloseTo(10 * (size - 1.001) + (size - 1.001), 2);
  });

  it('returns null for every point when tiles cannot be decoded (no OffscreenCanvas)', async () => {
    const out = await sampleTerrariumElevations([{ lat: 46.5, lon: 8.0 }, { lat: 45.9, lon: 6.9 }]);
    expect(out).toEqual([null, null]);
  });
});
