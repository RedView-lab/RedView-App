// ============================================
// Octree LOD — Build, Voxel Sampling & Flatten
// ============================================
//
// Typed-array, in-place implementation. Positions and RGBA colors are
// partitioned together (stable counting sort per node), so every node owns a
// contiguous range that keeps the original point order while it is split:
//  - voxel sampling runs on that range at split time, which yields exactly the
//    same "first point wins" samples as a per-point root→leaf walk;
//  - octant-ordered partitioning makes the leaves appear in DFS flatten order,
//    so the partitioned buffers *are* the final leaf buffers (no copy).
// Inputs are consumed: `positions` and `colors` are reordered in place and
// returned as `leafPositions` / `leafColors`.

import type { AABB, SerializedNode, FlatOctree } from './types';
import { MAX_POINTS_PER_NODE, MAX_DEPTH, OCCUPANCY_GRID_SIZE } from './types';

const GRID = OCCUPANCY_GRID_SIZE;
const GRID_WORDS = Math.ceil((GRID * GRID * GRID) / 32);
const GRID_CELLS = GRID * GRID * GRID;

interface BuildNode {
  id: number;
  depth: number;
  aabb: AABB;
  children: (BuildNode | null)[];
  isLeaf: boolean;
  /** Point range [start, end) in the partitioned buffers. */
  start: number;
  end: number;
  voxelPositions: Float32Array | null;
  voxelColors: Uint32Array | null;
  subtreePointCount: number;
}

function childAABB(parent: AABB, octant: number): AABB {
  const mx = (parent.minX + parent.maxX) * 0.5;
  const my = (parent.minY + parent.maxY) * 0.5;
  const mz = (parent.minZ + parent.maxZ) * 0.5;
  return {
    minX: (octant & 1) ? mx : parent.minX,
    maxX: (octant & 1) ? parent.maxX : mx,
    minY: (octant & 2) ? my : parent.minY,
    maxY: (octant & 2) ? parent.maxY : my,
    minZ: (octant & 4) ? mz : parent.minZ,
    maxZ: (octant & 4) ? parent.maxZ : mz,
  };
}

/**
 * Deterministic 32-bit hash → used as PRNG seed for in-leaf shuffle.
 * Keeps build reproducible across runs.
 */
function pcg32(state: number): number {
  state = (Math.imul(state, 747796405) + 2891336453) >>> 0;
  const word = (Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737)) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/**
 * Fisher–Yates shuffle of a leaf range using a seeded PRNG.
 * After this, taking the first N entries yields a spatially-uniform random
 * subset of the leaf — required so CPU-side density (instanceCount reduction)
 * doesn't produce visible spatial banding.
 */
function shuffleLeafRange(
  positions: Float32Array,
  colors: Uint32Array,
  start: number,
  end: number,
  seed: number,
  perm: Uint32Array,
  tmpPositions: Float32Array,
  tmpColors: Uint32Array,
): void {
  const n = end - start;
  for (let i = 0; i < n; i++) perm[i] = i;
  let state = (seed | 0) || 1;
  for (let i = n - 1; i > 0; i--) {
    state = pcg32(state);
    const j = state % (i + 1);
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }
  for (let k = 0; k < n; k++) {
    const src = start + perm[k]!;
    tmpPositions[k * 3] = positions[src * 3]!;
    tmpPositions[k * 3 + 1] = positions[src * 3 + 1]!;
    tmpPositions[k * 3 + 2] = positions[src * 3 + 2]!;
    tmpColors[k] = colors[src]!;
  }
  positions.set(tmpPositions.subarray(0, n * 3), start * 3);
  colors.set(tmpColors.subarray(0, n), start);
}

export function buildOctree(
  positions: Float32Array,
  colors: Uint8Array,
  bounds: AABB,
  onProgress?: (msg: string, pct: number) => void,
): FlatOctree {
  const totalPoints = positions.length / 3;
  let nextNodeId = 0;

  const eps = 0.01;
  const rootAABB: AABB = {
    minX: bounds.minX - eps,
    minY: bounds.minY - eps,
    minZ: bounds.minZ - eps,
    maxX: bounds.maxX + eps,
    maxY: bounds.maxY + eps,
    maxZ: bounds.maxZ + eps,
  };

  // Make root AABB cubic
  const sx = rootAABB.maxX - rootAABB.minX;
  const sy = rootAABB.maxY - rootAABB.minY;
  const sz = rootAABB.maxZ - rootAABB.minZ;
  const maxSide = Math.max(sx, sy, sz);
  const cx = (rootAABB.minX + rootAABB.maxX) * 0.5;
  const cy = (rootAABB.minY + rootAABB.maxY) * 0.5;
  const cz = (rootAABB.minZ + rootAABB.maxZ) * 0.5;
  const half = maxSide * 0.5;
  rootAABB.minX = cx - half;
  rootAABB.maxX = cx + half;
  rootAABB.minY = cy - half;
  rootAABB.maxY = cy + half;
  rootAABB.minZ = cz - half;
  rootAABB.maxZ = cz + half;

  const createNode = (depth: number, aabb: AABB, start: number, end: number): BuildNode => ({
    id: nextNodeId++,
    depth,
    aabb,
    children: [null, null, null, null, null, null, null, null],
    isLeaf: true,
    start,
    end,
    voxelPositions: null,
    voxelColors: null,
    subtreePointCount: end - start,
  });

  onProgress?.('Building octree — inserting points...', 10);

  // RGBA handled as one 32-bit word per point.
  const rgba = colors.byteOffset % 4 === 0 && colors.length === totalPoints * 4
    ? colors
    : new Uint8Array(colors.subarray(0, totalPoints * 4));
  const pos = positions;
  const col = new Uint32Array(rgba.buffer, rgba.byteOffset, totalPoints);
  const scratchPos = new Float32Array(totalPoints * 3);
  const scratchCol = new Uint32Array(totalPoints);
  const octants = new Uint8Array(totalPoints);
  const occGrid = new Uint32Array(GRID_WORDS);
  const samplePos = new Float32Array(GRID_CELLS * 3);
  const sampleCol = new Uint32Array(GRID_CELLS);
  const counts = new Uint32Array(8);
  const cursors = new Uint32Array(8);

  const root = createNode(0, rootAABB, 0, totalPoints);

  onProgress?.('Building octree — splitting nodes...', 20);
  const splitWork: BuildNode[] = [root];
  let pointsProcessed = 0;
  let lastProgressPoints = 0;

  while (splitWork.length > 0) {
    const node = splitWork.pop()!;
    const { start, end } = node;
    if (end - start <= MAX_POINTS_PER_NODE || node.depth >= MAX_DEPTH) continue;

    node.isLeaf = false;
    const aabb = node.aabb;
    const minX = aabb.minX, minY = aabb.minY, minZ = aabb.minZ;
    const mx = (aabb.minX + aabb.maxX) * 0.5;
    const my = (aabb.minY + aabb.maxY) * 0.5;
    const mz = (aabb.minZ + aabb.maxZ) * 0.5;
    const dx = aabb.maxX - aabb.minX;
    const dy = aabb.maxY - aabb.minY;
    const dz = aabb.maxZ - aabb.minZ;

    // Single sequential pass: octant classification + voxel sampling.
    occGrid.fill(0);
    counts.fill(0);
    let sampleCount = 0;
    const order: number[] = [];

    for (let k = start; k < end; k++) {
      const j = k * 3;
      const x = pos[j]!, y = pos[j + 1]!, z = pos[j + 2]!;

      const ix = Math.min(GRID - 1, Math.floor(((x - minX) / dx) * GRID));
      const iy = Math.min(GRID - 1, Math.floor(((y - minY) / dy) * GRID));
      const iz = Math.min(GRID - 1, Math.floor(((z - minZ) / dz) * GRID));
      const bit = (iz * GRID + iy) * GRID + ix;
      const word = bit >>> 5;
      const mask = 1 << (bit & 31);
      if ((occGrid[word]! & mask) === 0) {
        occGrid[word]! |= mask;
        const s = sampleCount * 3;
        samplePos[s] = x;
        samplePos[s + 1] = y;
        samplePos[s + 2] = z;
        sampleCol[sampleCount] = col[k]!;
        sampleCount++;
      }

      const octant = (x >= mx ? 1 : 0) | (y >= my ? 2 : 0) | (z >= mz ? 4 : 0);
      octants[k] = octant;
      if (counts[octant]++ === 0) order.push(octant);
    }
    node.voxelPositions = samplePos.slice(0, sampleCount * 3);
    node.voxelColors = sampleCol.slice(0, sampleCount);

    // Stable counting partition into octant order.
    let offset = start;
    for (let o = 0; o < 8; o++) {
      cursors[o] = offset;
      offset += counts[o]!;
    }
    for (let k = start; k < end; k++) {
      const dst = cursors[octants[k]!]!++;
      scratchPos[dst * 3] = pos[k * 3]!;
      scratchPos[dst * 3 + 1] = pos[k * 3 + 1]!;
      scratchPos[dst * 3 + 2] = pos[k * 3 + 2]!;
      scratchCol[dst] = col[k]!;
    }
    pos.set(scratchPos.subarray(start * 3, end * 3), start * 3);
    col.set(scratchCol.subarray(start, end), start);

    // Children are created (ids assigned) in first-encounter order.
    for (const o of order) {
      const childEnd = cursors[o]!;
      node.children[o] = createNode(node.depth + 1, childAABB(aabb, o), childEnd - counts[o]!, childEnd);
    }

    for (const child of node.children) {
      if (child && child.end - child.start > MAX_POINTS_PER_NODE) {
        splitWork.push(child);
      }
    }

    pointsProcessed += end - start;
    if (pointsProcessed - lastProgressPoints >= 4_000_000) {
      lastProgressPoints = pointsProcessed;
      onProgress?.('Building octree — splitting nodes...', Math.min(80, 20 + (pointsProcessed / (totalPoints * 5)) * 60));
    }
  }

  onProgress?.('Building octree — flattening...', 85);

  // DFS in octant order: leaves come out in partition order (pointOffset ==
  // start), voxels are concatenated in the same pre-order.
  let totalVoxels = 0;
  let nodeCount = 0;
  let maxDepthReached = 0;
  let maxLeafCount = 0;
  const internalNodes: BuildNode[] = [];
  const leafNodes: BuildNode[] = [];
  const countSubtree = (node: BuildNode): number => {
    nodeCount++;
    if (node.depth > maxDepthReached) maxDepthReached = node.depth;
    if (node.isLeaf) {
      node.subtreePointCount = node.end - node.start;
      if (node.subtreePointCount > 0) leafNodes.push(node);
      if (node.subtreePointCount > maxLeafCount) maxLeafCount = node.subtreePointCount;
      return node.subtreePointCount;
    }
    if (node.voxelPositions && node.voxelPositions.length > 0) internalNodes.push(node);
    totalVoxels += node.voxelColors?.length ?? 0;
    let total = 0;
    for (const child of node.children) {
      if (child) total += countSubtree(child);
    }
    node.subtreePointCount = total;
    return total;
  };
  countSubtree(root);

  // Shuffle every leaf so its first N points form a spatially-uniform subset
  // (renderer's CPU-side density: drawCount = count * density).
  const perm = new Uint32Array(maxLeafCount);
  for (const leaf of leafNodes) {
    shuffleLeafRange(pos, col, leaf.start, leaf.end, leaf.id + 1, perm, scratchPos, scratchCol);
  }

  const voxelPositions = new Float32Array(totalVoxels * 3);
  const voxelColorWords = new Uint32Array(totalVoxels);
  const voxelOffsets = new Map<BuildNode, number>();
  let voxelOffset = 0;
  for (const node of internalNodes) {
    voxelOffsets.set(node, voxelOffset);
    voxelPositions.set(node.voxelPositions!, voxelOffset * 3);
    voxelColorWords.set(node.voxelColors!, voxelOffset);
    voxelOffset += node.voxelColors!.length;
  }

  const serialize = (node: BuildNode): SerializedNode => {
    const count = node.end - node.start;
    const serialized: SerializedNode = {
      id: node.id,
      depth: node.depth,
      aabb: node.aabb,
      children: [null, null, null, null, null, null, null, null],
      isLeaf: node.isLeaf,
      pointOffset: node.isLeaf && count > 0 ? node.start : 0,
      pointCount: node.isLeaf ? count : 0,
      voxelOffset: voxelOffsets.get(node) ?? 0,
      voxelCount: node.isLeaf ? 0 : (node.voxelColors?.length ?? 0),
      subtreePointCount: node.subtreePointCount,
    };
    for (let i = 0; i < 8; i++) {
      const child = node.children[i];
      if (child) serialized.children[i] = serialize(child);
    }
    return serialized;
  };
  const serializedRoot = serialize(root);

  onProgress?.('Octree build complete', 100);

  return {
    root: serializedRoot,
    leafPositions: pos,
    leafColors: rgba,
    voxelPositions,
    voxelColors: new Uint8Array(voxelColorWords.buffer),
    totalLeafPoints: totalPoints,
    totalVoxelSamples: totalVoxels,
    maxDepthReached,
    nodeCount,
  };
}
