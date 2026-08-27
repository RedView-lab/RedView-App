import type { VisibleNode } from '../lod/types';
import { drawRange, type PointChunkBuffers } from './chunks';

export interface BatchDrawStats {
  batches: number;
  drawCalls: number;
}

// Preallocated array to avoid GC during frame rendering
let nodeIndicesCache = new Int32Array(4096);

export function drawNodesBatched(
  pass: GPURenderPassEncoder,
  visibleNodes: VisibleNode[],
  chunks: PointChunkBuffers[],
  isVoxel: boolean,
  _pointChunkCapacity: number,
): BatchDrawStats {
  let batches = 0;
  let drawCalls = 0;
  const chunkState = { index: -1 };

  // 1. Collect and filter matching node indices
  const count = visibleNodes.length;
  if (count > nodeIndicesCache.length) {
    nodeIndicesCache = new Int32Array(Math.max(nodeIndicesCache.length * 2, count + 1024));
  }

  let matchCount = 0;
  for (let i = 0; i < count; i++) {
    const node = visibleNodes[i];
    if (node && node.isVoxel === isVoxel && node.count > 0) {
      nodeIndicesCache[matchCount++] = i;
    }
  }

  if (matchCount === 0) {
    return { batches: 0, drawCalls: 0 };
  }

  // 2. Sort matching indices by node offset to maximize contiguous memory spans
  const indices = nodeIndicesCache.subarray(0, matchCount);
  indices.sort((a, b) => visibleNodes[a]!.offset - visibleNodes[b]!.offset);

  // 3. Merge contiguous ranges into single WebGPU draw calls
  let rangeStart = -1;
  let rangeCount = 0;

  const flushRange = () => {
    if (rangeStart < 0 || rangeCount <= 0) return;
    drawCalls += drawRange(pass, chunks, rangeStart, rangeCount, chunkState);
    batches += 1;
    rangeStart = -1;
    rangeCount = 0;
  };

  for (let k = 0; k < matchCount; k++) {
    const node = visibleNodes[indices[k]]!;
    const drawCount = node.density >= 0.995
      ? node.count
      : Math.max(1, Math.ceil(node.count * node.density));

    if (rangeStart < 0) {
      rangeStart = node.offset;
      rangeCount = drawCount;
    } else if (rangeStart + rangeCount === node.offset && drawCount === node.count) {
      // Contiguous with full count: extend the merged batch
      rangeCount += drawCount;
    } else {
      flushRange();
      rangeStart = node.offset;
      rangeCount = drawCount;
    }
  }

  flushRange();

  return { batches, drawCalls };
}

