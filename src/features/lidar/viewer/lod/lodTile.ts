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
// Points are packed per node in 16 bytes:
//   [0..5] x, y, z as u16, quantized in the node cube (≤ 1.5 cm at the root
//          of a 1 km tile, sub-centimetre below; LiDAR HD scale is 1 cm)
//   [6] classification  [7] intensity (8-bit, tile percentile-scaled)
//   [8..10] r, g, b
//   [11] filtered intensity  [12..14] filtered r, g, b  [15] 0
// so a node block is read from disk and uploaded to the GPU as is.
//
// Filtered values (see `filterLodAttributes`) are the mean over the point's
// cell of the node grid (node size / 128) of every point of the subtree. Where
// a node is the finest level drawn, each of its points stands for its whole
// cell, as a texel of a texture mip level does; drawn with its own colour it
// would be one sample of a 20 cm orthophoto, and far away the coarse levels
// turned into salt-and-pepper noise. Leaves keep their own values.

import type {
  CopcHierarchyInfo,
  DetectedCrs,
  PointCloudBounds,
  PointCloudOrigin,
} from '../../types';

export const LOD_POINT_STRIDE = 16;
/** Byte offsets of the attributes inside a packed point record. */
export const LOD_RECORD = {
  classification: 6,
  intensity: 7,
  rgb: 8,
  filteredIntensity: 11,
  filteredRgb: 12,
} as const;
/** Grid resolution of the additive subsampling (spacing = node size / 128). */
export const LOD_GRID = 128;
/** u16 position → cell of the node grid (65536 / LOD_GRID = 2^9). */
const CELL_SHIFT = 9;
const CELL_BITS = 7;
const CELL_MASK = LOD_GRID - 1;
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
 * tile (sensor ranges vary: 12-bit, 16-bit, with rare saturated outliers),
 * as a lookup table indexed by the raw value; null when every point gets 0.
 */
function buildIntensityTable(intensities: Uint16Array | undefined, count: number): Uint8Array | null {
  if (!intensities || count === 0) return null;
  const histogram = new Uint32Array(65536);
  let nonZero = 0;
  for (let i = 0; i < count; i++) {
    const value = intensities[i]!;
    if (value > 0) {
      histogram[value]!++;
      nonZero++;
    }
  }
  if (nonZero === 0) return null;
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
  const table = new Uint8Array(65536);
  for (let value = low + 1; value < 65536; value++) {
    table[value] = value >= high ? 255 : Math.round(((value - low) / range) * 255);
  }
  return table;
}

function parseKey(key: string): [number, number, number, number] {
  const parts = key.split('-');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

/**
 * Quantizes `count` points into `packed` from point slot `firstSlot` on:
 * input point `indices[from + k]`, or `from + k` without `indices`. One
 * monomorphic loop per node (a call per point through a DataView and a
 * closure cost 80 ns/point, most of the build on a 23 M point tile).
 * Positions are written as u16 words: the packed format is little-endian
 * and so is every platform with WebGPU/WebGL (see `filterLodAttributes`).
 */
function packPoints(
  packed: Uint8Array,
  words: Uint16Array,
  firstSlot: number,
  input: LodTileInput,
  indices: Uint32Array | null,
  from: number,
  count: number,
  cube: { minX: number; minY: number; minZ: number; size: number },
  intensityTable: Uint8Array | null,
): void {
  const { positions, colors, classifications } = input;
  const intensities = intensityTable ? input.intensities! : null;
  const scale = 65535 / cube.size;
  const { minX, minY, minZ } = cube;
  for (let k = 0; k < count; k++) {
    const pointIndex = indices ? indices[from + k]! : from + k;
    const p = pointIndex * 3;
    const byteOffset = (firstSlot + k) * LOD_POINT_STRIDE;
    const w = byteOffset >> 1;
    const qx = Math.round((positions[p]! - minX) * scale);
    const qy = Math.round((positions[p + 1]! - minY) * scale);
    const qz = Math.round((positions[p + 2]! - minZ) * scale);
    words[w] = qx < 0 ? 0 : qx > 65535 ? 65535 : qx;
    words[w + 1] = qy < 0 ? 0 : qy > 65535 ? 65535 : qy;
    words[w + 2] = qz < 0 ? 0 : qz > 65535 ? 65535 : qz;
    const intensity = intensities ? intensityTable![intensities[pointIndex]!]! : 0;
    const r = colors[p]!;
    const g = colors[p + 1]!;
    const b = colors[p + 2]!;
    packed[byteOffset + 6] = classifications[pointIndex]!;
    packed[byteOffset + 7] = intensity;
    packed[byteOffset + 8] = r;
    packed[byteOffset + 9] = g;
    packed[byteOffset + 10] = b;
    // Filtered copies, replaced by the cell means for nodes with children.
    packed[byteOffset + 11] = intensity;
    packed[byteOffset + 12] = r;
    packed[byteOffset + 13] = g;
    packed[byteOffset + 14] = b;
    packed[byteOffset + 15] = 0;
  }
}

function packedWords(packed: Uint8Array): Uint16Array {
  return new Uint16Array(packed.buffer, packed.byteOffset, packed.byteLength >> 1);
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
  const words = packedWords(packed);
  const intensityTable = buildIntensityTable(input.intensities, input.count);
  const nodes: LodNode[] = [];
  let pointIndex = 0;
  for (const entry of copc.nodes) {
    const [depth, x, y, z] = parseKey(entry.key);
    const node: LodNode = { depth, x, y, z, count: entry.pointCount, byteOffset: pointIndex * LOD_POINT_STRIDE };
    packPoints(packed, words, pointIndex, input, null, pointIndex, entry.pointCount, lodNodeCube(header, node), intensityTable);
    pointIndex += entry.pointCount;
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
  const words = packedWords(packed);
  const intensityTable = buildIntensityTable(input.intensities, n);
  const nodes: LodNode[] = [];
  let written = 0;
  for (const { node, start } of emitted) {
    const lodNode: LodNode = { ...node, byteOffset: written * LOD_POINT_STRIDE };
    packPoints(packed, words, written, input, order, start, node.count, lodNodeCube(header, lodNode), intensityTable);
    written += node.count;
    nodes.push(lodNode);
  }
  header.nodeCount = nodes.length;
  return { header, nodes, packed };
}

/** Builds the LOD tile, reusing the COPC octree when the file has one. */
export function buildLodTile(input: LodTileInput): LodTile {
  const tile = (input.copc ? buildFromCopc(input, input.copc) : null) ?? buildAdditive(input);
  filterLodAttributes(tile);
  return tile;
}

/** Occupied cells of a node grid with the attribute sums of the points they hold. */
interface CellSums {
  /** Cell keys: x | y << 7 | z << 14 in the node grid. */
  keys: Uint32Array;
  /** Per cell: r, g, b, intensity, point count. */
  sums: Uint32Array;
  size: number;
}

const SUM_FIELDS = 5;

/**
 * Writes the filtered attributes of every node that has children: each
 * point gets the mean colour and intensity of all the points of its subtree
 * lying in its cell of the node grid (box filter of the node spacing, cells
 * in 3D so a canopy and the ground under it stay apart). Cell sums are built
 * bottom-up, a node merging its children's cells into its own twice coarser
 * grid (child cubes nest exactly in their parent's), so the whole tile costs
 * one pass over the points plus one over the occupied cells per level.
 * Nodes without points are skipped: their children feed the nearest
 * ancestor that has points.
 */
export function filterLodAttributes(tile: LodTile): void {
  const { nodes, packed } = tile;
  const count = nodes.length;
  if (count === 0) return;
  if (packed.byteOffset % 2 !== 0) throw new Error('LOD point data must be 2-byte aligned');
  const words = new Uint16Array(packed.buffer, packed.byteOffset, packed.byteLength >> 1);
  const wordStride = LOD_POINT_STRIDE >> 1;

  const keyOf = (d: number, x: number, y: number, z: number) => `${d}-${x}-${y}-${z}`;
  const byKey = new Map<string, number>();
  nodes.forEach((node, i) => byKey.set(keyOf(node.depth, node.x, node.y, node.z), i));
  const children: number[][] = nodes.map(() => []);
  const roots: number[] = [];
  nodes.forEach((node, i) => {
    if (node.count === 0) return;
    for (let d = node.depth - 1; d >= 0; d--) {
      const shift = node.depth - d;
      const j = byKey.get(keyOf(d, node.x >> shift, node.y >> shift, node.z >> shift));
      if (j !== undefined && nodes[j]!.count > 0) {
        children[j]!.push(i);
        return;
      }
    }
    roots.push(i);
  });

  const cellCount = 1 << (3 * CELL_BITS);
  const slotOfCell = new Int32Array(cellCount).fill(-1);
  const summaries: (CellSums | null)[] = new Array(count).fill(null);
  // Scratch of the node being merged (merges never nest), grown on demand: a
  // node grid has at most `cellCount` occupied cells. Its summary is copied
  // out trimmed and the used sums zeroed again.
  let keys = new Uint32Array(0);
  let sums = new Uint32Array(0);
  let pointSlots = new Int32Array(0);

  /** Cell sums of an internal node's subtree in its grid; writes its filtered attributes. */
  const merge = (index: number): CellSums => {
    const node = nodes[index]!;
    const kids = children[index]!;
    let capacity = node.count;
    for (const child of kids) capacity += summaries[child]?.size ?? nodes[child]!.count;
    capacity = Math.min(capacity, cellCount);
    if (keys.length < capacity) {
      const grown = Math.min(cellCount, Math.max(capacity, keys.length * 2));
      keys = new Uint32Array(grown);
      sums = new Uint32Array(grown * SUM_FIELDS);
    }
    if (pointSlots.length < node.count) pointSlots = new Int32Array(Math.max(node.count, pointSlots.length * 2));
    let size = 0;
    const firstWord = node.byteOffset >> 1;

    for (let k = 0; k < node.count; k++) {
      const w = firstWord + k * wordStride;
      const cell = (words[w]! >> CELL_SHIFT)
        | ((words[w + 1]! >> CELL_SHIFT) << CELL_BITS)
        | ((words[w + 2]! >> CELL_SHIFT) << (2 * CELL_BITS));
      let slot = slotOfCell[cell]!;
      if (slot < 0) {
        slot = size++;
        slotOfCell[cell] = slot;
        keys[slot] = cell;
      }
      pointSlots[k] = slot;
      const at = w << 1;
      const s = slot * SUM_FIELDS;
      sums[s] = sums[s]! + packed[at + LOD_RECORD.rgb]!;
      sums[s + 1] = sums[s + 1]! + packed[at + LOD_RECORD.rgb + 1]!;
      sums[s + 2] = sums[s + 2]! + packed[at + LOD_RECORD.rgb + 2]!;
      sums[s + 3] = sums[s + 3]! + packed[at + LOD_RECORD.intensity]!;
      sums[s + 4] = sums[s + 4]! + 1;
    }

    for (const childIndex of kids) {
      const child = nodes[childIndex]!;
      const shift = child.depth - node.depth;
      const ox = (child.x - (node.x << shift)) << CELL_BITS;
      const oy = (child.y - (node.y << shift)) << CELL_BITS;
      const oz = (child.z - (node.z << shift)) << CELL_BITS;
      const summary = summaries[childIndex];
      if (summary) {
        summaries[childIndex] = null;
        const childKeys = summary.keys;
        const childSums = summary.sums;
        for (let e = 0; e < summary.size; e++) {
          const key = childKeys[e]!;
          const cell = ((ox + (key & CELL_MASK)) >> shift)
            | (((oy + ((key >> CELL_BITS) & CELL_MASK)) >> shift) << CELL_BITS)
            | (((oz + (key >> (2 * CELL_BITS))) >> shift) << (2 * CELL_BITS));
          let slot = slotOfCell[cell]!;
          if (slot < 0) {
            slot = size++;
            slotOfCell[cell] = slot;
            keys[slot] = cell;
          }
          const s = slot * SUM_FIELDS;
          const c = e * SUM_FIELDS;
          sums[s] = sums[s]! + childSums[c]!;
          sums[s + 1] = sums[s + 1]! + childSums[c + 1]!;
          sums[s + 2] = sums[s + 2]! + childSums[c + 2]!;
          sums[s + 3] = sums[s + 3]! + childSums[c + 3]!;
          sums[s + 4] = sums[s + 4]! + childSums[c + 4]!;
        }
        continue;
      }
      // A leaf (most of the points): its filtered values are never drawn,
      // so its points go straight into this grid instead of through a
      // summary of their own (same integer sums, half the work).
      const childWord = child.byteOffset >> 1;
      for (let k = 0; k < child.count; k++) {
        const w = childWord + k * wordStride;
        const cell = ((ox + (words[w]! >> CELL_SHIFT)) >> shift)
          | (((oy + (words[w + 1]! >> CELL_SHIFT)) >> shift) << CELL_BITS)
          | (((oz + (words[w + 2]! >> CELL_SHIFT)) >> shift) << (2 * CELL_BITS));
        let slot = slotOfCell[cell]!;
        if (slot < 0) {
          slot = size++;
          slotOfCell[cell] = slot;
          keys[slot] = cell;
        }
        const at = w << 1;
        const s = slot * SUM_FIELDS;
        sums[s] = sums[s]! + packed[at + LOD_RECORD.rgb]!;
        sums[s + 1] = sums[s + 1]! + packed[at + LOD_RECORD.rgb + 1]!;
        sums[s + 2] = sums[s + 2]! + packed[at + LOD_RECORD.rgb + 2]!;
        sums[s + 3] = sums[s + 3]! + packed[at + LOD_RECORD.intensity]!;
        sums[s + 4] = sums[s + 4]! + 1;
      }
    }

    for (let k = 0; k < node.count; k++) {
      const s = pointSlots[k]! * SUM_FIELDS;
      const n = sums[s + 4]!;
      const at = node.byteOffset + k * LOD_POINT_STRIDE;
      packed[at + LOD_RECORD.filteredRgb] = Math.round(sums[s]! / n);
      packed[at + LOD_RECORD.filteredRgb + 1] = Math.round(sums[s + 1]! / n);
      packed[at + LOD_RECORD.filteredRgb + 2] = Math.round(sums[s + 2]! / n);
      packed[at + LOD_RECORD.filteredIntensity] = Math.round(sums[s + 3]! / n);
    }

    for (let e = 0; e < size; e++) slotOfCell[keys[e]!] = -1;
    // Trimmed: a summary waits for its parent while the siblings are merged.
    const summary: CellSums = { keys: keys.slice(0, size), sums: sums.slice(0, size * SUM_FIELDS), size };
    sums.fill(0, 0, size * SUM_FIELDS);
    return summary;
  };

  // Post-order, depth first: only the summaries of the current path's
  // siblings are alive at once (tens of MB, not one per node of a level).
  // Leaves get no summary: their parent reads their points.
  for (const root of roots) {
    const stack: Array<{ index: number; next: number }> = [{ index: root, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const kids = children[top.index]!;
      if (top.next < kids.length) {
        stack.push({ index: kids[top.next++]!, next: 0 });
        continue;
      }
      stack.pop();
      if (kids.length === 0) continue;
      const summary = merge(top.index);
      summaries[top.index] = stack.length > 0 ? summary : null;
    }
  }
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
