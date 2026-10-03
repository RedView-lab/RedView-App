// ============================================
// LiDAR viewer tools — ray picking on the point cloud (CPU)
// ============================================
//
// Picks the front-most LiDAR return within a few pixels of a screen ray,
// among the LOD nodes drawn this frame: what the user actually sees (tree
// crown, cliff, roof), not the ground model under it. Node blocks are read
// from the LOD cache (the same OPFS slices the GPU was fed) and kept in a
// small LRU, so successive picks in one area stay instant.

import { readLodNodeBlock, type OpenedLodTile } from '../../../lib/lodCache';
import { LOD_POINT_STRIDE } from '../../lod/lodTile';
import type { SceneNode } from '../../lod/sceneLod';
import type { Vec3 } from '../types';

export interface PointPickQuery {
  origin: Vec3;
  /** Unit direction. */
  direction: Vec3;
  /** Pick radius per metre along the ray (pixel cone). */
  radiusPerMeter: number;
  /** Pick radius floor (half a point diameter), m. */
  minRadiusM: number;
  /** Returns beyond this distance are hidden (behind the ground), m. */
  maxDistance: number;
}

export interface PointPickHit {
  local: Vec3;
  /** Distance along the ray, m. */
  distance: number;
  classification: number;
}

interface Candidate {
  node: SceneNode;
  enter: number;
}

/** LRU budget of decoded node blocks, bytes. */
const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
/** Upper bound of node blocks scanned per pick. */
const MAX_NODES_PER_PICK = 96;
/** ASPRS noise classes (low/high noise) are never picked. */
const NOISE_CLASSES = new Set([7, 18]);

export class PointCloudPicker {
  private readonly cache = new Map<number, ArrayBuffer>();
  private cacheBytes = 0;

  private readonly tiles: readonly OpenedLodTile[];
  private readonly getDrawnNodes: () => readonly SceneNode[];
  private readonly isClassVisible: (classification: number) => boolean;

  constructor(
    tiles: readonly OpenedLodTile[],
    getDrawnNodes: () => readonly SceneNode[],
    isClassVisible: (classification: number) => boolean,
  ) {
    this.tiles = tiles;
    this.getDrawnNodes = getDrawnNodes;
    this.isClassVisible = isClassVisible;
  }

  async pick(query: PointPickQuery): Promise<PointPickHit | null> {
    const candidates = this.collectCandidates(query);
    let best: PointPickHit | null = null;
    for (const { node, enter } of candidates) {
      if (best && enter > best.distance) break;
      const block = await this.readBlock(node);
      if (!block) continue;
      const hit = this.scanBlock(node, block, query, best?.distance ?? query.maxDistance);
      if (hit) best = hit;
    }
    return best;
  }

  private collectCandidates(query: PointPickQuery): Candidate[] {
    const [ox, oy, oz] = query.origin;
    const [dx, dy, dz] = query.direction;
    const out: Candidate[] = [];
    for (const node of this.getDrawnNodes()) {
      if (node.virtual || node.entry.count === 0) continue;
      // Grow the box by the pick radius at its distance.
      const cx = (node.minX + node.maxX) / 2 - ox;
      const cy = (node.minY + node.maxY) / 2 - oy;
      const cz = (node.minZ + node.maxZ) / 2 - oz;
      const margin = query.minRadiusM + query.radiusPerMeter * Math.hypot(cx, cy, cz);
      const enter = raySlab(ox, oy, oz, dx, dy, dz, node, margin, query.maxDistance);
      if (enter != null) out.push({ node, enter });
    }
    out.sort((a, b) => a.enter - b.enter);
    return out.slice(0, MAX_NODES_PER_PICK);
  }

  private scanBlock(node: SceneNode, block: ArrayBuffer, query: PointPickQuery, maxDistance: number): PointPickHit | null {
    const count = Math.min(node.entry.count, Math.floor(block.byteLength / LOD_POINT_STRIDE));
    const words = new Uint16Array(block, 0, (count * LOD_POINT_STRIDE) >> 1);
    const bytes = new Uint8Array(block, 0, count * LOD_POINT_STRIDE);
    const s = node.size / 65535;
    const [ox, oy, oz] = query.origin;
    const [dx, dy, dz] = query.direction;
    // Ray origin relative to the node's quantization corner.
    const rx = ox - node.originX;
    const ry = oy - node.originY;
    const rz = oz - node.originZ;
    let bestDistance = maxDistance;
    let bestIndex = -1;
    const step = LOD_POINT_STRIDE >> 1;
    for (let p = 0, w = 0; p < count; p++, w += step) {
      // Quantized CRS axes (east, north, up) → render frame (east, up, −north).
      const vx = words[w]! * s - rx;
      const vy = words[w + 2]! * s - ry;
      const vz = -words[w + 1]! * s - rz;
      const t = vx * dx + vy * dy + vz * dz;
      if (t <= 0.05 || t >= bestDistance) continue;
      const radius = Math.max(query.minRadiusM, query.radiusPerMeter * t);
      const perp2 = vx * vx + vy * vy + vz * vz - t * t;
      if (perp2 > radius * radius) continue;
      const cls = bytes[p * LOD_POINT_STRIDE + 6]!;
      if (NOISE_CLASSES.has(cls) || !this.isClassVisible(cls)) continue;
      bestDistance = t;
      bestIndex = p;
    }
    if (bestIndex < 0) return null;
    const w = bestIndex * step;
    return {
      local: [
        node.originX + words[w]! * s,
        node.originY + words[w + 2]! * s,
        node.originZ - words[w + 1]! * s,
      ],
      distance: bestDistance,
      classification: bytes[bestIndex * LOD_POINT_STRIDE + 6]!,
    };
  }

  private async readBlock(node: SceneNode): Promise<ArrayBuffer | null> {
    const cached = this.cache.get(node.id);
    if (cached) {
      this.cache.delete(node.id);
      this.cache.set(node.id, cached);
      return cached;
    }
    const tile = this.tiles[node.tileIndex];
    if (!tile) return null;
    try {
      const block = await readLodNodeBlock(tile, node.entry);
      this.cache.set(node.id, block);
      this.cacheBytes += block.byteLength;
      for (const [id, old] of this.cache) {
        if (this.cacheBytes <= CACHE_BUDGET_BYTES) break;
        this.cache.delete(id);
        this.cacheBytes -= old.byteLength;
      }
      return block;
    } catch (error) {
      console.warn('[LiDAR tools] Node read failed during picking:', error);
      return null;
    }
  }
}

/** Entry distance of a ray into a box grown by `margin`, `null` when missed. */
function raySlab(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  margin: number,
  maxDistance: number,
): number | null {
  let tmin = 0;
  let tmax = maxDistance;
  const axes: Array<[number, number, number, number]> = [
    [ox, dx, box.minX - margin, box.maxX + margin],
    [oy, dy, box.minY - margin, box.maxY + margin],
    [oz, dz, box.minZ - margin, box.maxZ + margin],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
