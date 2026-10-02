// ============================================
// LiDAR LOD tile: additive octree + packed point blocks
// ============================================
//
// A tile is an *additive* octree (as in COPC/Potree): every node holds a
// spatially uniform subset of its cube's points and its children add the
// rest, so a node is always drawn in full and no point is stored twice.
// COPC files already are such an octree; other LAS/LAZ files get one built
// here (first point per 128³ grid cell stays in the node).
//
// Points are packed per node in 12 bytes:
//   [0..5] x, y, z as u16, quantized in the node cube (≤ 1.5 cm at the root
//          of a 1 km tile, sub-centimetre below; LiDAR HD scale is 1 cm)
//   [6] classification  [7] intensity (8-bit, tile percentile-scaled)
//   [8..10] r, g, b     [11] 0
// so a node block is read from disk and uploaded to the GPU as is.

import type {
  CopcHierarchyInfo,
  DetectedCrs,
  PointCloudBounds,
  PointCloudOrigin,
} from '../../types';

export const LOD_POINT_STRIDE = 12;
/** Grid resolution of the additive subsampling (spacing = node size / 128). */
export const LOD_GRID = 128;
const LEAF_MAX_POINTS = 60_000;
const MAX_DEPTH = 16;

export interface LodNode {
  depth: number;
  x: number;
  y: number;
  z: number;
  count: number;
  /** Byte offset of the node's block in the packed data. */
  byteOffset: number;
}

export interface LodTileHeader {
  pointCount: number;
  nodeCount: number;
  /** Absolute CRS bounds. */
  bounds: PointCloudBounds;
  /** Absolute km-aligned origin (see PointCloudOrigin). */
  origin: PointCloudOrigin;
  /** Octree cube relative to `origin`: min corner and edge length. */
  cubeMinX: number;
  cubeMinY: number;
  cubeMinZ: number;
  cubeSize: number;
  /** Point spacing of the root node; halves at each level. */
  rootSpacing: number;
  crs: DetectedCrs;
  embeddedRgb: boolean;
}

export interface LodTileInput {
  /** XYZ relative to `origin`. */
  positions: Float32Array;
  /** RGB per point. */
  colors: Uint8Array;
  classifications: Uint8Array;
  intensities?: Uint16Array;
  count: number;
  bounds: PointCloudBounds;
  origin: PointCloudOrigin;
  crs: DetectedCrs;
  embeddedRgb?: boolean;
  copc?: CopcHierarchyInfo;
}

export interface LodTile {
  header: LodTileHeader;
  nodes: LodNode[];
  /** `pointCount * LOD_POINT_STRIDE` bytes, node blocks back to back. */
  packed: Uint8Array;
}

/** Node cube (relative to the tile origin) from its octree key. */
export function lodNodeCube(header: LodTileHeader, node: Pick<LodNode, 'depth' | 'x' | 'y' | 'z'>): {
  minX: number; minY: number; minZ: number; size: number;
} {
  const size = header.cubeSize / 2 ** node.depth;
  return {
    minX: header.cubeMinX + node.x * size,
    minY: header.cubeMinY + node.y * size,
    minZ: header.cubeMinZ + node.z * size,
    size,
  };
}

export function lodNodeSpacing(header: LodTileHeader, depth: number): number {
  return header.rootSpacing / 2 ** depth;
}

/**
 * Maps raw intensities to 8 bits with the 1st–99th percentile range of the
 * tile (sensor ranges vary: 12-bit, 16-bit, with rare saturated outliers).
 */
function buildIntensityScale(intensities: Uint16Array | undefined, count: number): (value: number) => number {
  if (!intensities || count === 0) return () => 0;
  const histogram = new Uint32Array(65536);
  let nonZero = 0;
  for (let i = 0; i < count; i++) {
    const value = intensities[i]!;
    if (value > 0) {
      histogram[value]!++;
      nonZero++;
    }
  }
  if (nonZero === 0) return () => 0;
  const lowTarget = nonZero * 0.01;
  const highTarget = nonZero * 0.99;
  let low = 1;
  let high = 65535;
  let seen = 0;
  for (let v = 1; v < 65536; v++) {
    seen += histogram[v]!;
    if (seen >= lowTarget && low === 1) low = v;
    if (seen >= highTarget) {
      high = v;
      break;
    }
  }
  const range = Math.max(1, high - low);
  return (value) => (value <= low ? 0 : value >= high ? 255 : Math.round(((value - low) / range) * 255));
}

function parseKey(key: string): [number, number, number, number] {
  const parts = key.split('-');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

/** Quantizes one point into `packed` at `byteOffset`. */
function writePackedPoint(
  view: DataView,
  bytes: Uint8Array,
  byteOffset: number,
  input: LodTileInput,
  pointIndex: number,
  cube: { minX: number; minY: number; minZ: number; size: number },
  intensityScale: (value: number) => number,
): void {
  const scale = 65535 / cube.size;
  const p = pointIndex * 3;
  const qx = Math.round((input.positions[p]! - cube.minX) * scale);
  const qy = Math.round((input.positions[p + 1]! - cube.minY) * scale);
  const qz = Math.round((input.positions[p + 2]! - cube.minZ) * scale);
  view.setUint16(byteOffset, qx < 0 ? 0 : qx > 65535 ? 65535 : qx, true);
  view.setUint16(byteOffset + 2, qy < 0 ? 0 : qy > 65535 ? 65535 : qy, true);
  view.setUint16(byteOffset + 4, qz < 0 ? 0 : qz > 65535 ? 65535 : qz, true);
  bytes[byteOffset + 6] = input.classifications[pointIndex]!;
  bytes[byteOffset + 7] = intensityScale(input.intensities?.[pointIndex] ?? 0);
  bytes[byteOffset + 8] = input.colors[p]!;
  bytes[byteOffset + 9] = input.colors[p + 1]!;
  bytes[byteOffset + 10] = input.colors[p + 2]!;
  bytes[byteOffset + 11] = 0;
}

function makeHeader(
  input: LodTileInput,
  nodeCount: number,
  cube: { minX: number; minY: number; minZ: number; size: number },
  rootSpacing: number,
): LodTileHeader {
  return {
    pointCount: input.count,
    nodeCount,
    bounds: { ...input.bounds },
    origin: { ...input.origin },
    cubeMinX: cube.minX,
    cubeMinY: cube.minY,
    cubeMinZ: cube.minZ,
    cubeSize: cube.size,
    rootSpacing,
    crs: input.crs,
    embeddedRgb: input.embeddedRgb ?? false,
  };
}

/** COPC: points are already grouped per node, in `copc.nodes` order. */
function buildFromCopc(input: LodTileInput, copc: CopcHierarchyInfo): LodTile | null {
  const total = copc.nodes.reduce((sum, node) => sum + node.pointCount, 0);
  if (total !== input.count) return null;
  const cubeSize = Math.max(copc.cube[3]! - copc.cube[0]!, copc.cube[4]! - copc.cube[1]!, copc.cube[5]! - copc.cube[2]!);
  const rootCube = {
    minX: copc.cube[0]! - input.origin.x,
    minY: copc.cube[1]! - input.origin.y,
    minZ: copc.cube[2]! - input.origin.z,
    size: cubeSize,
  };
  const header = makeHeader(input, copc.nodes.length, rootCube, copc.spacing);
  const packed = new Uint8Array(input.count * LOD_POINT_STRIDE);
  const view = new DataView(packed.buffer);
  const intensityScale = buildIntensityScale(input.intensities, input.count);
  const nodes: LodNode[] = [];
  let pointIndex = 0;
  for (const entry of copc.nodes) {
    const [depth, x, y, z] = parseKey(entry.key);
    const node: LodNode = { depth, x, y, z, count: entry.pointCount, byteOffset: pointIndex * LOD_POINT_STRIDE };
    const cube = lodNodeCube(header, node);
    for (let k = 0; k < entry.pointCount; k++, pointIndex++) {
      writePackedPoint(view, packed, pointIndex * LOD_POINT_STRIDE, input, pointIndex, cube, intensityScale);
    }
    nodes.push(node);
  }
  return { header, nodes, packed };
}

/**
 * Additive octree for plain LAS/LAZ: the first point of each occupied
 * 128³ cell stays in the node, the others are partitioned into the octants;
 * nodes under `LEAF_MAX_POINTS` (or at `MAX_DEPTH`) keep everything.
 */
function buildAdditive(input: LodTileInput): LodTile {
  const n = input.count;
  const positions = input.positions;
  const b = input.bounds;
  const o = input.origin;
  const eps = 0.01;
  const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) + 2 * eps;
  const rootCube = { minX: b.minX - o.x - eps, minY: b.minY - o.y - eps, minZ: b.minZ - o.z - eps, size };
  const header = makeHeader(input, 0, rootCube, size / LOD_GRID);

  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const scratch = new Uint32Array(n);
  const occupancy = new Uint32Array((LOD_GRID * LOD_GRID * LOD_GRID) >>> 5);
  const counts = new Uint32Array(8);
  const cursors = new Uint32Array(8);

  interface Pending { depth: number; x: number; y: number; z: number; start: number; end: number }
  const emitted: { node: Omit<LodNode, 'byteOffset'>; start: number }[] = [];
  const stack: Pending[] = [{ depth: 0, x: 0, y: 0, z: 0, start: 0, end: n }];

  while (stack.length > 0) {
    const item = stack.pop()!;
    const count = item.end - item.start;
    if (count === 0) continue;
    if (count <= LEAF_MAX_POINTS || item.depth >= MAX_DEPTH) {
      emitted.push({ node: { depth: item.depth, x: item.x, y: item.y, z: item.z, count }, start: item.start });
      continue;
    }
    const cube = lodNodeCube(header, item);
    const cellScale = LOD_GRID / cube.size;
    occupancy.fill(0);
    let keep = 0;
    for (let k = item.start; k < item.end; k++) {
      const p = order[k]! * 3;
      const cx = Math.min(LOD_GRID - 1, Math.max(0, Math.floor((positions[p]! - cube.minX) * cellScale)));
      const cy = Math.min(LOD_GRID - 1, Math.max(0, Math.floor((positions[p + 1]! - cube.minY) * cellScale)));
      const cz = Math.min(LOD_GRID - 1, Math.max(0, Math.floor((positions[p + 2]! - cube.minZ) * cellScale)));
      const bit = (cz * LOD_GRID + cy) * LOD_GRID + cx;
      const word = bit >>> 5;
      const mask = 1 << (bit & 31);
      if ((occupancy[word]! & mask) !== 0) continue;
      occupancy[word]! |= mask;
      const dst = item.start + keep;
      const tmp = order[dst]!;
      order[dst] = order[k]!;
      order[k] = tmp;
      keep++;
    }
    emitted.push({ node: { depth: item.depth, x: item.x, y: item.y, z: item.z, count: keep }, start: item.start });

    // Partition the remaining points into octants (stable counting sort).
    const restStart = item.start + keep;
    const half = cube.size / 2;
    const midX = cube.minX + half, midY = cube.minY + half, midZ = cube.minZ + half;
    counts.fill(0);
    for (let k = restStart; k < item.end; k++) {
      const p = order[k]! * 3;
      const octant = (positions[p]! >= midX ? 1 : 0) | (positions[p + 1]! >= midY ? 2 : 0) | (positions[p + 2]! >= midZ ? 4 : 0);
      counts[octant]!++;
    }
    let offset = restStart;
    for (let octant = 0; octant < 8; octant++) {
      cursors[octant] = offset;
      offset += counts[octant]!;
    }
    for (let k = restStart; k < item.end; k++) {
      const p = order[k]! * 3;
      const octant = (positions[p]! >= midX ? 1 : 0) | (positions[p + 1]! >= midY ? 2 : 0) | (positions[p + 2]! >= midZ ? 4 : 0);
      scratch[cursors[octant]!++] = order[k]!;
    }
    order.set(scratch.subarray(restStart, item.end), restStart);
    let childStart = restStart;
    for (let octant = 0; octant < 8; octant++) {
      const childCount = counts[octant]!;
      if (childCount > 0) {
        stack.push({
          depth: item.depth + 1,
          x: item.x * 2 + (octant & 1),
          y: item.y * 2 + ((octant >> 1) & 1),
          z: item.z * 2 + ((octant >> 2) & 1),
          start: childStart,
          end: childStart + childCount,
        });
      }
      childStart += childCount;
    }
  }

  emitted.sort((a, b2) => a.node.depth - b2.node.depth);
  const packed = new Uint8Array(n * LOD_POINT_STRIDE);
  const view = new DataView(packed.buffer);
  const intensityScale = buildIntensityScale(input.intensities, n);
  const nodes: LodNode[] = [];
  let written = 0;
  for (const { node, start } of emitted) {
    const lodNode: LodNode = { ...node, byteOffset: written * LOD_POINT_STRIDE };
    const cube = lodNodeCube(header, lodNode);
    for (let k = 0; k < node.count; k++, written++) {
      writePackedPoint(view, packed, written * LOD_POINT_STRIDE, input, order[start + k]!, cube, intensityScale);
    }
    nodes.push(lodNode);
  }
  header.nodeCount = nodes.length;
  return { header, nodes, packed };
}

/** Builds the LOD tile, reusing the COPC octree when the file has one. */
export function buildLodTile(input: LodTileInput): LodTile {
  if (input.copc) {
    const fromCopc = buildFromCopc(input, input.copc);
    if (fromCopc) return fromCopc;
  }
  return buildAdditive(input);
}

/** Decodes the position of one packed point (relative to the tile origin). */
export function unpackLodPosition(
  view: DataView,
  byteOffset: number,
  cube: { minX: number; minY: number; minZ: number; size: number },
): [number, number, number] {
  const scale = cube.size / 65535;
  return [
    cube.minX + view.getUint16(byteOffset, true) * scale,
    cube.minY + view.getUint16(byteOffset + 2, true) * scale,
    cube.minZ + view.getUint16(byteOffset + 4, true) * scale,
  ];
}
