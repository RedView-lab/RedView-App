import { performance } from 'node:perf_hooks';
import {
  buildLodTile,
  LOD_POINT_STRIDE,
  lodNodeCube,
  unpackLodPosition,
  type LodTileInput,
} from '../../src/features/lidar/viewer/lod/lodTile.ts';
import { check, createRandom } from './harness.ts';

// ---------------------------------------------------------------------------
// 3–4. Octree LOD et streaming multi-tuiles
// ---------------------------------------------------------------------------

/** Rolling terrain with tree-like clusters, positions relative to a km-aligned origin. */
export function syntheticTile(tileX: number, tileY: number, count: number): LodTileInput {
  const rand = createRandom(1000 + tileX * 31 + tileY * 17);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const classifications = new Uint8Array(count);
  const origin = { x: 1_000_000 + tileX * 1000, y: 6_543_000 + tileY * 1000, z: 0 };
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = rand() * 1000;
    const y = rand() * 1000;
    const ground = 1200 + 40 * Math.sin((origin.x + x) / 180) + 30 * Math.cos((origin.y + y) / 140);
    const isTree = rand() < 0.3;
    const z = ground + (isTree ? 2 + rand() * 18 : 0);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    classifications[i] = isTree ? 5 : 2;
    colors[i * 3] = isTree ? 40 : 150;
    colors[i * 3 + 1] = isTree ? 110 : 130;
    colors[i * 3 + 2] = isTree ? 40 : 90;
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return {
    positions,
    colors,
    classifications,
    count,
    origin,
    crs: 'LAMB93',
    bounds: {
      minX: origin.x, maxX: origin.x + 1000,
      minY: origin.y, maxY: origin.y + 1000,
      minZ, maxZ,
    },
  };
}

export function runLodTileCheck(): void {
  const count = 600_000;
  const input = syntheticTile(0, 0, count);
  const positions = input.positions.slice();
  const t0 = performance.now();
  const tile = buildLodTile(input);
  const buildMs = performance.now() - t0;

  const total = tile.nodes.reduce((sum, node) => sum + node.count, 0);
  let maxErr = 0;
  let sumErr = 0;
  let samples = 0;
  let withinBound = true;
  // Every packed point must decode near an original point; sample by nearest grid bucket.
  const bucket = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const key = `${Math.floor(positions[i * 3]!)}:${Math.floor(positions[i * 3 + 1]!)}`;
    let list = bucket.get(key);
    if (!list) bucket.set(key, (list = []));
    list.push(i);
  }
  const view = new DataView(tile.packed.buffer);
  for (const node of tile.nodes) {
    const cube = lodNodeCube(tile.header, node);
    // Rounding to the u16 grid of the node cube: at most half a step per axis.
    const bound = (cube.size / 65535) * (Math.sqrt(3) / 2) + 1e-4;
    for (let k = 0; k < node.count; k += 97) {
      const [x, y, z] = unpackLodPosition(view, node.byteOffset + k * LOD_POINT_STRIDE, cube);
      let best = Infinity;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const i of bucket.get(`${Math.floor(x) + dx}:${Math.floor(y) + dy}`) ?? []) {
            best = Math.min(best, Math.hypot(positions[i * 3]! - x, positions[i * 3 + 1]! - y, positions[i * 3 + 2]! - z));
          }
        }
      }
      maxErr = Math.max(maxErr, best);
      sumErr += best;
      samples++;
      if (best > bound) withinBound = false;
    }
  }
  check(
    `Octree LOD additive (600k pts, ${tile.nodes.length} nœuds, ${buildMs.toFixed(0)} ms)`,
    total === count && tile.packed.byteLength === count * LOD_POINT_STRIDE && withinBound,
    'octree reconstruite + échantillons voxels dupliqués (16 o/pt + doublons)',
    `${total === count ? 'chaque point une fois' : `${total} ≠ ${count}`}, 12 o/pt, ` +
    `erreur moyenne ${((sumErr / Math.max(1, samples)) * 1000).toFixed(2)} mm (max ${(maxErr * 1000).toFixed(1)} mm, racine d’1 km)`,
  );
}
