// ============================================
// Viewer LiDAR HD — génération du terrain heightmap (enveloppe du worker)
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

    const { positions, colors, classifications, count } = copyTerrainPoints(pc);
    // Les positions sont relatives à `pc.origin` : donner au worker l'emprise dans
    // ce repère (seules les différences comptent pour la grille et le maillage centré).
    const { bounds, origin } = pc;

    worker.postMessage(
      {
        type: 'generate',
        positions,
        colors,
        classifications,
        count,
        bounds: {
          minX: bounds.minX - origin.x, maxX: bounds.maxX - origin.x,
          minY: bounds.minY - origin.y, maxY: bounds.maxY - origin.y,
          minZ: bounds.minZ - origin.z, maxZ: bounds.maxZ - origin.z,
        },
        resolution,
      },
      [positions.buffer, colors.buffer, classifications.buffer],
    );
  });
}

const isGroundClass = (cls: number) => cls === 2 || cls === 9 || cls === 17;
const isNoiseClass = (cls: number) => cls === 7 || cls === 18;

/**
 * Copie seulement les points que le worker va projeter (même règle de sélection
 * que `heightmapWorker`) : les classes sol quand il y en a assez, sinon tout
 * sauf le bruit. Évite une copie complète du nuage pour le transfert.
 */
function copyTerrainPoints(pc: PointCloudData): {
  positions: Float32Array;
  colors: Uint8Array;
  classifications: Uint8Array;
  count: number;
} {
  const cls = pc.classifications;
  let groundCount = 0;
  for (let i = 0; i < pc.count; i++) {
    if (isGroundClass(cls[i]!)) groundCount++;
  }
  const useStrictGround = groundCount >= Math.min(1000, pc.count * 0.05);
  const keep = useStrictGround ? isGroundClass : (c: number) => !isNoiseClass(c);

  let count = 0;
  for (let i = 0; i < pc.count; i++) {
    if (keep(cls[i]!)) count++;
  }
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const classifications = new Uint8Array(count);
  let k = 0;
  for (let i = 0; i < pc.count; i++) {
    if (!keep(cls[i]!)) continue;
    positions[k * 3] = pc.positions[i * 3]!;
    positions[k * 3 + 1] = pc.positions[i * 3 + 1]!;
    positions[k * 3 + 2] = pc.positions[i * 3 + 2]!;
    colors[k * 3] = pc.colors[i * 3]!;
    colors[k * 3 + 1] = pc.colors[i * 3 + 1]!;
    colors[k * 3 + 2] = pc.colors[i * 3 + 2]!;
    classifications[k] = cls[i]!;
    k++;
  }
  return { positions, colors, classifications, count };
}
