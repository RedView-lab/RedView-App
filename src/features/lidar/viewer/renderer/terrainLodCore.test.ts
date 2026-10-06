import { describe, expect, it } from 'vitest';
import { mat4MultiplyInto } from './math';
import { TERRAIN_VERTEX_FLOATS, TerrainLodSelector, type TerrainMeshData } from './terrainLodCore';

/** Two 256 m tiles side by side (1 m grid, gentle relief), merged as the viewer does. */
function twoTiles(): TerrainMeshData {
  const n = 257;
  const vertices = new Float32Array(2 * n * n * TERRAIN_VERTEX_FLOATS);
  const parts = [0, 1].map((tile) => {
    const vertexOffset = tile * n * n;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = tile * 256 + c - 256;
        const z = r - 128;
        const at = (vertexOffset + r * n + c) * TERRAIN_VERTEX_FLOATS;
        vertices[at] = x;
        vertices[at + 1] = 20 * Math.sin(x / 40) * Math.cos(z / 30);
        vertices[at + 2] = z;
        vertices[at + 4] = 1;
      }
    }
    return { vertexOffset, gridWidth: n, gridHeight: n };
  });
  return { vertices, colors: new Uint8Array(2 * n * n * 4), parts };
}

/** View-projection looking down at the scene from `height` metres. */
function viewProjFrom(height: number): Float32Array {
  const view = new Float32Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, -height, 1]);
  const f = 1 / Math.tan(Math.PI / 8);
  const proj = new Float32Array(16);
  proj[0] = f;
  proj[5] = f;
  proj[11] = -1;
  proj[14] = 0.05;
  return mat4MultiplyInto(new Float32Array(16), proj, view);
}

describe('TerrainLodSelector', () => {
  it('cuts each tile into chunks and links neighbours across tiles', () => {
    const selector = new TerrainLodSelector(twoTiles());
    expect(selector.chunks).toHaveLength(8);
    const linked = selector.chunks.filter((chunk) => chunk.neighbours.some((n, side) => n >= 0 && selector.chunks[n]!.baseVertex >= 257 * 257 !== chunk.baseVertex >= 257 * 257 && side >= 0));
    // The two chunk columns facing each other across the tile seam.
    expect(linked.length).toBe(4);
  });

  it('shares every full-size pattern per grid width', () => {
    const groups = new TerrainLodSelector(twoTiles()).sharedPatterns();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(5 * 16 + 1);
  });

  it('keeps full resolution close, coarsens far away, and keeps neighbours within one level', () => {
    const selector = new TerrainLodSelector(twoTiles());
    selector.select(viewProjFrom(30), 0, 30, 0, 1000);
    const near = Math.min(...selector.levels);
    selector.select(viewProjFrom(5000), 0, 5000, 0, 1000);
    const far = Math.max(...selector.levels);
    expect(near).toBe(0);
    expect(far).toBeGreaterThan(near);
    for (let i = 0; i < selector.chunks.length; i++) {
      for (const n of selector.chunks[i]!.neighbours) {
        if (n >= 0) expect(Math.abs(selector.levels[i]! - selector.levels[n]!)).toBeLessThanOrEqual(1);
      }
      // A coarse chunk is pushed behind the true surface by its error.
      expect(selector.pushBack[i]! > 0).toBe(selector.levels[i]! > 0);
    }
  });
});
