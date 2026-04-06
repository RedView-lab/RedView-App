// ============================================
// Octree LOD — Build, Voxel Sampling & Flatten
// ============================================

import type { AABB, OctreeNode, SerializedNode, FlatOctree } from './types';
import { MAX_POINTS_PER_NODE, MAX_DEPTH, OCCUPANCY_GRID_SIZE } from './types';

const GRID = OCCUPANCY_GRID_SIZE;
const GRID_WORDS = Math.ceil((GRID * GRID * GRID) / 32);

function createOccupancyGrid(): Uint32Array {
  return new Uint32Array(GRID_WORDS);
}

function testAndSet(grid: Uint32Array, ix: number, iy: number, iz: number): boolean {
  const bit = (iz * GRID + iy) * GRID + ix;
  const word = bit >>> 5;
  const mask = 1 << (bit & 31);
  if (grid[word] & mask) return false;
  grid[word] |= mask;
  return true;
}

interface BuildNode {
  id: number;
  depth: number;
  aabb: AABB;
  children: (BuildNode | null)[];
  isLeaf: boolean;
  pointIndices: number[];
  voxelSamples: number[];
  occGrid: Uint32Array | null;
  subtreePointCount: number;
}

let nextNodeId = 0;

function createNode(depth: number, aabb: AABB): BuildNode {
  return {
    id: nextNodeId++,
    depth,
    aabb,
    children: [null, null, null, null, null, null, null, null],
    isLeaf: true,
    pointIndices: [],
    voxelSamples: [],
    occGrid: null,
    subtreePointCount: 0,
  };
}

function getOctant(aabb: AABB, x: number, y: number, z: number): number {
  const mx = (aabb.minX + aabb.maxX) * 0.5;
  const my = (aabb.minY + aabb.maxY) * 0.5;
  const mz = (aabb.minZ + aabb.maxZ) * 0.5;
  return (x >= mx ? 1 : 0) | (y >= my ? 2 : 0) | (z >= mz ? 4 : 0);
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

function tryVoxelSample(
  node: BuildNode,
  x: number, y: number, z: number,
  r: number, g: number, b: number, a: number,
): void {
  if (!node.occGrid) node.occGrid = createOccupancyGrid();

  const aabb = node.aabb;
  const ix = Math.min(GRID - 1, Math.floor(((x - aabb.minX) / (aabb.maxX - aabb.minX)) * GRID));
  const iy = Math.min(GRID - 1, Math.floor(((y - aabb.minY) / (aabb.maxY - aabb.minY)) * GRID));
  const iz = Math.min(GRID - 1, Math.floor(((z - aabb.minZ) / (aabb.maxZ - aabb.minZ)) * GRID));

  if (testAndSet(node.occGrid, ix, iy, iz)) {
    node.voxelSamples.push(x, y, z, r, g, b, a);
  }
}

function splitNode(
  node: BuildNode,
  positions: Float32Array,
  colors: Uint8Array,
): void {
  node.isLeaf = false;
  const indices = node.pointIndices;
  node.pointIndices = [];

  for (let k = 0; k < indices.length; k++) {
    const idx = indices[k];
    const j = idx * 3;
    const x = positions[j], y = positions[j + 1], z = positions[j + 2];
    const octant = getOctant(node.aabb, x, y, z);

    if (!node.children[octant]) {
      node.children[octant] = createNode(node.depth + 1, childAABB(node.aabb, octant));
    }
    node.children[octant]!.pointIndices.push(idx);
  }
}

function countSubtree(node: BuildNode): number {
  if (node.isLeaf) {
    node.subtreePointCount = node.pointIndices.length;
    return node.subtreePointCount;
  }
  let total = 0;
  for (const child of node.children) {
    if (child) total += countSubtree(child);
  }
  node.subtreePointCount = total;
  return total;
}

interface FlattenContext {
  leafPositions: Float32Array;
  leafColors: Uint8Array;
  voxelPositions: Float32Array;
  voxelColors: Uint8Array;
  leafOffset: number;
  voxelOffset: number;
}

function flattenNode(
  node: BuildNode,
  positions: Float32Array,
  colors: Uint8Array,
  ctx: FlattenContext,
): SerializedNode {
  const serialized: SerializedNode = {
    id: node.id,
    depth: node.depth,
    aabb: node.aabb,
    children: [null, null, null, null, null, null, null, null],
    isLeaf: node.isLeaf,
    pointOffset: 0,
    pointCount: 0,
    voxelOffset: 0,
    voxelCount: 0,
    subtreePointCount: node.subtreePointCount,
  };

  if (node.isLeaf && node.pointIndices.length > 0) {
    serialized.pointOffset = ctx.leafOffset;
    serialized.pointCount = node.pointIndices.length;

    for (let k = 0; k < node.pointIndices.length; k++) {
      const idx = node.pointIndices[k];
      const src = idx * 3;
      const dst = (ctx.leafOffset + k) * 3;
      ctx.leafPositions[dst] = positions[src];
      ctx.leafPositions[dst + 1] = positions[src + 1];
      ctx.leafPositions[dst + 2] = positions[src + 2];

      const sc = idx * 4;
      const dc = (ctx.leafOffset + k) * 4;
      ctx.leafColors[dc] = colors[sc];
      ctx.leafColors[dc + 1] = colors[sc + 1];
      ctx.leafColors[dc + 2] = colors[sc + 2];
      ctx.leafColors[dc + 3] = colors[sc + 3];
    }
    ctx.leafOffset += node.pointIndices.length;
  }

  if (!node.isLeaf && node.voxelSamples.length > 0) {
    const nVoxels = node.voxelSamples.length / 7;
    serialized.voxelOffset = ctx.voxelOffset;
    serialized.voxelCount = nVoxels;

    for (let k = 0; k < nVoxels; k++) {
      const s = k * 7;
      const dp = (ctx.voxelOffset + k) * 3;
      ctx.voxelPositions[dp] = node.voxelSamples[s];
      ctx.voxelPositions[dp + 1] = node.voxelSamples[s + 1];
      ctx.voxelPositions[dp + 2] = node.voxelSamples[s + 2];

      const dc = (ctx.voxelOffset + k) * 4;
      ctx.voxelColors[dc] = node.voxelSamples[s + 3];
      ctx.voxelColors[dc + 1] = node.voxelSamples[s + 4];
      ctx.voxelColors[dc + 2] = node.voxelSamples[s + 5];
      ctx.voxelColors[dc + 3] = node.voxelSamples[s + 6];
    }
    ctx.voxelOffset += nVoxels;
  }

  for (let i = 0; i < 8; i++) {
    if (node.children[i]) {
      serialized.children[i] = flattenNode(node.children[i]!, positions, colors, ctx);
    }
  }

  return serialized;
}

function countVoxels(node: BuildNode): number {
  let total = node.voxelSamples.length / 7;
  for (const child of node.children) {
    if (child) total += countVoxels(child);
  }
  return total;
}

function countNodes(node: BuildNode): number {
  let total = 1;
  for (const child of node.children) {
    if (child) total += countNodes(child);
  }
  return total;
}

function getMaxDepth(node: BuildNode): number {
  if (node.isLeaf) return node.depth;
  let max = node.depth;
  for (const child of node.children) {
    if (child) max = Math.max(max, getMaxDepth(child));
  }
  return max;
}

export function buildOctree(
  positions: Float32Array,
  colors: Uint8Array,
  bounds: AABB,
  onProgress?: (msg: string, pct: number) => void,
): FlatOctree {
  const totalPoints = positions.length / 3;

  nextNodeId = 0;

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

  const root = createNode(0, rootAABB);

  onProgress?.('Building octree — inserting points...', 10);

  for (let i = 0; i < totalPoints; i++) {
    root.pointIndices.push(i);
  }
  root.subtreePointCount = totalPoints;

  onProgress?.('Building octree — splitting nodes...', 20);
  const splitWork: BuildNode[] = [root];

  while (splitWork.length > 0) {
    const node = splitWork.pop()!;
    if (!node.isLeaf) continue;
    if (node.pointIndices.length <= MAX_POINTS_PER_NODE || node.depth >= MAX_DEPTH) continue;

    node.isLeaf = false;
    const indices = node.pointIndices;
    node.pointIndices = [];

    for (let k = 0; k < indices.length; k++) {
      const idx = indices[k];
      const j = idx * 3;
      const x = positions[j], y = positions[j + 1], z = positions[j + 2];
      const octant = getOctant(node.aabb, x, y, z);

      if (!node.children[octant]) {
        node.children[octant] = createNode(node.depth + 1, childAABB(node.aabb, octant));
      }
      node.children[octant]!.pointIndices.push(idx);
    }

    for (const child of node.children) {
      if (child && child.pointIndices.length > MAX_POINTS_PER_NODE) {
        splitWork.push(child);
      }
    }
  }

  // Voxel sampling
  onProgress?.('Building octree — voxel sampling...', 50);
  for (let i = 0; i < totalPoints; i++) {
    const j = i * 3;
    const x = positions[j], y = positions[j + 1], z = positions[j + 2];
    const c = i * 4;
    const r = colors[c], g = colors[c + 1], b = colors[c + 2], a = colors[c + 3];

    let node = root;
    while (!node.isLeaf) {
      tryVoxelSample(node, x, y, z, r, g, b, a);
      const octant = getOctant(node.aabb, x, y, z);
      const child = node.children[octant];
      if (!child) break;
      node = child;
    }

    if (i > 0 && (i % 2_000_000) === 0) {
      onProgress?.(`Voxel sampling... ${((i / totalPoints) * 100).toFixed(0)}%`, 50 + (i / totalPoints) * 30);
    }
  }

  onProgress?.('Building octree — finalizing...', 85);
  countSubtree(root);

  onProgress?.('Building octree — flattening...', 90);

  const totalVoxels = countVoxels(root);
  const nodeCount = countNodes(root);
  const maxDepthReached = getMaxDepth(root);

  const ctx: FlattenContext = {
    leafPositions: new Float32Array(totalPoints * 3),
    leafColors: new Uint8Array(totalPoints * 4),
    voxelPositions: new Float32Array(totalVoxels * 3),
    voxelColors: new Uint8Array(totalVoxels * 4),
    leafOffset: 0,
    voxelOffset: 0,
  };

  const serializedRoot = flattenNode(root, positions, colors, ctx);

  onProgress?.('Octree build complete', 100);

  return {
    root: serializedRoot,
    leafPositions: ctx.leafPositions,
    leafColors: ctx.leafColors,
    voxelPositions: ctx.voxelPositions,
    voxelColors: ctx.voxelColors,
    totalLeafPoints: totalPoints,
    totalVoxelSamples: totalVoxels,
    maxDepthReached,
    nodeCount,
  };
}
