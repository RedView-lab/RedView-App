// ============================================
// LiDAR HD Viewer — Heightmap Terrain Generator (Worker Wrapper)
// ============================================

import type { PointCloudData } from '../types';

export interface HeightmapMesh {
  vertices: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  heightGrid: Float32Array;
  gridWidth: number;
  gridHeight: number;
}

export function generateHeightmap(pc: PointCloudData, resolution = 1.0): Promise<HeightmapMesh> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./heightmapWorker.ts', import.meta.url),
      { type: 'module' },
    );

    const TIMEOUT_MS = 30_000;
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Heightmap generation timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'done') {
        clearTimeout(timer);
        resolve({
          vertices: e.data.vertices as Float32Array,
          colors: e.data.colors as Uint8Array,
          indices: e.data.indices as Uint32Array,
          vertexCount: e.data.vertexCount,
          indexCount: e.data.indexCount,
          heightGrid: e.data.heightGrid as Float32Array,
          gridWidth: e.data.gridWidth,
          gridHeight: e.data.gridHeight,
        });
        worker.terminate();
      }
    };

    worker.onerror = (err) => {
      clearTimeout(timer);
      const msg = err instanceof ErrorEvent ? err.message : String(err);
      reject(new Error(`Heightmap worker error: ${msg}`));
      worker.terminate();
    };

    const posCopy = new Float32Array(pc.positions);
    const colCopy = new Uint8Array(pc.colors);
    const clsCopy = new Uint8Array(pc.classifications);

    worker.postMessage(
      {
        type: 'generate',
        positions: posCopy,
        colors: colCopy,
        classifications: clsCopy,
        count: pc.count,
        bounds: { ...pc.bounds },
        resolution,
      },
      [posCopy.buffer, colCopy.buffer, clsCopy.buffer],
    );
  });
}
