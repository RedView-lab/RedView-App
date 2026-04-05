import type { AABB, OctreeNode, FlatOctree } from './types';
import { MAX_DEPTH, MAX_LEAF_POINTS, OCCUPANCY_GRID_RES } from './types';

function splitAABB(aabb: AABB, octant: number): AABB {
  const mx = (aabb.minX + aabb.maxX) * 0.5;
  const my = (aabb.minY + aabb.maxY) * 0.5;
  const mz = (aabb.minZ + aabb.maxZ) * 0.5;
  return {
    minX: (octant & 1) ? mx : aabb.minX,
    maxX: (octant & 1) ? aabb.maxX : mx,
    minY: (octant & 2) ? my : aabb.minY,
    maxY: (octant & 2) ? aabb.maxY : my,
    minZ: (octant & 4) ? mz : aabb.minZ,
    maxZ: (octant & 4) ? aabb.maxZ : mz,
  };
}

function octantOf(px: number, py: number, pz: number, aabb: AABB): number {
  const mx = (aabb.minX + aabb.maxX) * 0.5;
  const my = (aabb.minY + aabb.maxY) * 0.5;
  const mz = (aabb.minZ + aabb.maxZ) * 0.5;
  return (px >= mx ? 1 : 0) | (py >= my ? 2 : 0) | (pz >= mz ? 4 : 0);
}

/**
 * Build a recursive octree from point cloud data.
 * Points are reordered in-place so leaf ranges are contiguous.
 */
export function buildOctree(
  positions: Float32Array,
  colors: Uint8Array,
  normals: Float32Array,
  count: number,
): FlatOctree {
  // Compute root AABB
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // Slight padding to avoid edge cases
  const pad = 0.01;
  const rootAABB: AABB = {
    minX: minX - pad, minY: minY - pad, minZ: minZ - pad,
    maxX: maxX + pad, maxY: maxY + pad, maxZ: maxZ + pad,
  };

  // Create index array for reordering
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;

  // Build tree iteratively using a stack
  interface BuildTask {
    node: OctreeNode;
    start: number;
    end: number; // exclusive
  }

  const root: OctreeNode = {
    aabb: rootAABB,
    depth: 0,
    pointStart: 0,
    pointCount: 0,
    voxelStart: 0,
    voxelCount: 0,
    children: Array(8).fill(null),
    subtreeCount: count,
  };

  const stack: BuildTask[] = [{ node: root, start: 0, end: count }];

  while (stack.length > 0) {
    const task = stack.pop()!;
    const { node, start, end } = task;
    const n = end - start;

    if (n <= MAX_LEAF_POINTS || node.depth >= MAX_DEPTH) {
      // Leaf node
      node.pointStart = start;
      node.pointCount = n;
      node.subtreeCount = n;
      continue;
    }

    // Partition points into 8 octants
    const buckets: number[][] = [[], [], [], [], [], [], [], []];
    for (let i = start; i < end; i++) {
      const idx = indices[i];
      const oct = octantOf(
        positions[idx * 3],
        positions[idx * 3 + 1],
        positions[idx * 3 + 2],
        node.aabb,
      );
      buckets[oct].push(idx);
    }

    // Reorder indices so each octant is contiguous
    let offset = start;
    for (let oct = 0; oct < 8; oct++) {
      const bucket = buckets[oct];
      if (bucket.length === 0) continue;

      const childStart = offset;
      for (let j = 0; j < bucket.length; j++) {
        indices[offset++] = bucket[j];
      }
      const childEnd = offset;

      const childNode: OctreeNode = {
        aabb: splitAABB(node.aabb, oct),
        depth: node.depth + 1,
        pointStart: 0,
        pointCount: 0,
        voxelStart: 0,
        voxelCount: 0,
        children: Array(8).fill(null),
        subtreeCount: bucket.length,
      };
      node.children[oct] = childNode;
      stack.push({ node: childNode, start: childStart, end: childEnd });
    }
  }

  // Phase 2: Build voxel samples at inner nodes using occupancy grid
  const voxelPositions: number[] = [];
  const voxelColors: number[] = [];
  const voxelNormals: number[] = [];

  function buildVoxels(node: OctreeNode): void {
    // Process children first (post-order)
    for (const child of node.children) {
      if (child) buildVoxels(child);
    }

    // Only inner nodes have voxels
    if (node.pointCount > 0) return; // leaf node

    const sizeX = node.aabb.maxX - node.aabb.minX;
    const sizeY = node.aabb.maxY - node.aabb.minY;
    const sizeZ = node.aabb.maxZ - node.aabb.minZ;
    const res = OCCUPANCY_GRID_RES;
    const invX = res / sizeX;
    const invY = res / sizeY;
    const invZ = res / sizeZ;

    // Occupancy grid: collect one sample per occupied cell
    const grid = new Map<number, number>(); // cell key → point index

    function collectLeaves(n: OctreeNode): void {
      if (n.pointCount > 0) {
        // Leaf: sample from its points
        for (let i = n.pointStart; i < n.pointStart + n.pointCount; i++) {
          const idx = indices[i];
          const cx = Math.min(res - 1, Math.floor((positions[idx * 3] - node.aabb.minX) * invX));
          const cy = Math.min(res - 1, Math.floor((positions[idx * 3 + 1] - node.aabb.minY) * invY));
          const cz = Math.min(res - 1, Math.floor((positions[idx * 3 + 2] - node.aabb.minZ) * invZ));
          const key = cx * res * res + cy * res + cz;
          if (!grid.has(key)) grid.set(key, idx);
        }
        return;
      }
      for (const child of n.children) {
        if (child) collectLeaves(child);
      }
    }
    collectLeaves(node);

    node.voxelStart = voxelPositions.length / 3;
    node.voxelCount = grid.size;
    for (const idx of grid.values()) {
      voxelPositions.push(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
      voxelColors.push(colors[idx * 3], colors[idx * 3 + 1], colors[idx * 3 + 2]);
      voxelNormals.push(normals[idx * 3], normals[idx * 3 + 1], normals[idx * 3 + 2]);
    }
  }

  buildVoxels(root);

  // Phase 3: Build contiguous output arrays
  // First: all leaf points (reordered), then voxel points
  let totalLeafPoints = 0;
  function countLeaves(node: OctreeNode): void {
    if (node.pointCount > 0) {
      totalLeafPoints += node.pointCount;
      return;
    }
    for (const child of node.children) {
      if (child) countLeaves(child);
    }
  }
  countLeaves(root);

  const totalVoxelPoints = voxelPositions.length / 3;
  const totalPoints = totalLeafPoints + totalVoxelPoints;

  const outPositions = new Float32Array(totalPoints * 3);
  const outColors = new Uint8Array(totalPoints * 3);
  const outNormals = new Float32Array(totalPoints * 3);

  // Write leaf points (reordered by octree traversal)
  let writeOffset = 0;
  function writeLeaves(node: OctreeNode): void {
    if (node.pointCount > 0) {
      const newStart = writeOffset;
      for (let i = node.pointStart; i < node.pointStart + node.pointCount; i++) {
        const idx = indices[i];
        outPositions[writeOffset * 3] = positions[idx * 3];
        outPositions[writeOffset * 3 + 1] = positions[idx * 3 + 1];
        outPositions[writeOffset * 3 + 2] = positions[idx * 3 + 2];
        outColors[writeOffset * 3] = colors[idx * 3];
        outColors[writeOffset * 3 + 1] = colors[idx * 3 + 1];
        outColors[writeOffset * 3 + 2] = colors[idx * 3 + 2];
        outNormals[writeOffset * 3] = normals[idx * 3];
        outNormals[writeOffset * 3 + 1] = normals[idx * 3 + 1];
        outNormals[writeOffset * 3 + 2] = normals[idx * 3 + 2];
        writeOffset++;
      }
      node.pointStart = newStart;
      return;
    }
    for (const child of node.children) {
      if (child) writeLeaves(child);
    }
  }
  writeLeaves(root);

  // Write voxel points after leaf points
  for (let i = 0; i < totalVoxelPoints; i++) {
    outPositions[(totalLeafPoints + i) * 3] = voxelPositions[i * 3];
    outPositions[(totalLeafPoints + i) * 3 + 1] = voxelPositions[i * 3 + 1];
    outPositions[(totalLeafPoints + i) * 3 + 2] = voxelPositions[i * 3 + 2];
    outColors[(totalLeafPoints + i) * 3] = voxelColors[i * 3];
    outColors[(totalLeafPoints + i) * 3 + 1] = voxelColors[i * 3 + 1];
    outColors[(totalLeafPoints + i) * 3 + 2] = voxelColors[i * 3 + 2];
    outNormals[(totalLeafPoints + i) * 3] = voxelNormals[i * 3];
    outNormals[(totalLeafPoints + i) * 3 + 1] = voxelNormals[i * 3 + 1];
    outNormals[(totalLeafPoints + i) * 3 + 2] = voxelNormals[i * 3 + 2];
  }

  // Adjust voxel start offsets to account for the leaf-points prefix
  function adjustVoxelOffsets(node: OctreeNode): void {
    if (node.voxelCount > 0) {
      node.voxelStart += totalLeafPoints;
    }
    for (const child of node.children) {
      if (child) adjustVoxelOffsets(child);
    }
  }
  adjustVoxelOffsets(root);

  return {
    root,
    positions: outPositions,
    colors: outColors,
    normals: outNormals,
    totalLeafPoints,
    totalVoxelPoints,
  };
}
