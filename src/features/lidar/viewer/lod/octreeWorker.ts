// ============================================
// Octree LOD — Web Worker
// ============================================

import { buildOctree } from './octree';
import type { AABB, OctreeWorkerResponse } from './types';

export interface OctreeWorkerRequest {
  type: 'build';
  positions: Float32Array;
  colors: Uint8Array;
  bounds: AABB;
}

function post(msg: OctreeWorkerResponse, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfer as any);
}

self.onmessage = (e: MessageEvent<OctreeWorkerRequest>) => {
  const { positions, colors, bounds } = e.data;

  try {
    const result = buildOctree(positions, colors, bounds, (message, percent) => {
      post({ type: 'progress', message, percent });
    });

    post(
      {
        type: 'done',
        root: result.root,
        leafPositions: result.leafPositions,
        leafColors: result.leafColors,
        voxelPositions: result.voxelPositions,
        voxelColors: result.voxelColors,
        totalLeafPoints: result.totalLeafPoints,
        totalVoxelSamples: result.totalVoxelSamples,
        maxDepthReached: result.maxDepthReached,
        nodeCount: result.nodeCount,
      },
      [
        result.leafPositions.buffer,
        result.leafColors.buffer,
        result.voxelPositions.buffer,
        result.voxelColors.buffer,
      ],
    );
  } catch (err: any) {
    post({ type: 'error', message: err.message || String(err) });
  }
};
