// ============================================
// Scene LOD: multi-tile additive octrees, streamed and budgeted
// ============================================
//
// Every tile is an additive octree (see lodTile.ts) whose node blocks live
// in the OPFS LOD cache. Each frame:
//  1. the roots of the visible tiles are always kept (no tile ever goes
//     blank), then nodes are visited by rank, highest first, and kept while
//     they fit in the point budget. A node's projected spacing is its point
//     spacing seen from the closest point of its bounds (device px); the
//     node is refined while that exceeds `TARGET_SPACING_PX`. Its rank is
//     that spacing weighted by foreshortening: a flat patch seen at a grazing
//     angle packs its points into few pixel rows, so under a tight budget it
//     yields to surfaces seen face-on. With enough budget every node reaches
//     the same target, whatever the angle;
//  2. the whole target is selected from the node table, loaded or not, and
//     counts against the budget: what is on screen converges to it without
//     reshuffling as deeper levels arrive. Missing nodes are loaded by rank,
//     coarse to fine (a node waits for its parent's points, which tighten
//     its bounds), and a node is only drawn below a drawn parent;
//  3. residency is bounded by a pool budget; least-recently selected nodes
//     are evicted first, tile roots never (no empty ground when turning).
// Node bounds start as the octree cube clipped to the tile bounds and shrink
// to the node's points once it is loaded: those sample every occupied cell
// of the node grid, so every point of the subtree lies within a cell of them
// (≤ 1.2 cells measured on IGN COPC tiles; 2 are kept). Tight bounds cull
// more and give true distances where a cube is mostly empty air.

import { readLodNodeBlock, type OpenedLodTile } from '../../lib/lodCache';
import { extractFrustumPlanes, frustumTestAABB, OUTSIDE } from './frustum';
import { LOD_POINT_STRIDE, lodNodeCube, lodNodeSpacing, type LodNode } from './lodTile';

/** Refine while a node's point spacing projects to more than this (device px). */
const TARGET_SPACING_PX = 1.25;
/** A refined node only collapses once its spacing drops below this fraction of the target. */
const UNREFINE_FACTOR = 0.7;
/** Nodes kept last frame (drawn or loading) rank higher… */
const KEEP_PRIORITY_BOOST = 1.3;
/** …and new nodes may only fill this share of the budget, so the two never trade places every frame. */
const NEW_NODE_BUDGET_SHARE = 0.97;
const MAX_CONCURRENT_LOADS = 6;
/**
 * Floor of the projected-area ratio used by the foreshortening weight
 * (its square root weights the spacing: ≥ 0.39, i.e. at most 2.6× coarser).
 */
const MIN_FORESHORTENING = 0.15;
/** Content bounds grow by this many grid cells to hold the node's whole subtree. */
export const CONTENT_MARGIN_CELLS = 2;
/** Distance floor (m) of the projected spacing: the camera's near plane. */
const MIN_VIEW_DISTANCE = 0.05;
/** Tile bounds are widened by this much (m) before clipping the octree cubes. */
const TILE_BOUNDS_EPSILON = 0.01;

export type SceneNodeState = 'idle' | 'loading' | 'resident' | 'failed';

export interface SceneNode {
  id: number;
  tileIndex: number;
  entry: LodNode;
  depth: number;
  /**
   * Conservative render-frame bounds (x east, y up, z = −north) of the node
   * and its whole subtree, relative to the scene centre; they shrink as
   * the node and its ancestors are loaded.
   */
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /**
   * Render-frame position of the quantization cube's min corner:
   * renderPos = origin + (qx·s, qz·s, −qy·s), q ∈ [0, 1].
   */
  originX: number; originY: number; originZ: number;
  size: number;
  /** Grid cell of the node's subsampling (nominal level spacing). */
  cell: number;
  /** Point spacing on a surface, for the projected-spacing test. */
  spacing: number;
  /**
   * Spacing the node's points grow to where none of its children is drawn
   * (adaptive point size); 0 for leaves, whose points are the full density.
   */
  adaptiveSpacing: number;
  parent: number;
  children: number[];
  state: SceneNodeState;
  lastSelectedFrame: number;
  /** Last frame the node was drawn (hysteresis against frame-to-frame swaps). */
  lastDrawnFrame: number;
  /** Last frame the node's children were visited (refinement hysteresis). */
  refinedFrame: number;
  /** Last frame the node's region was on screen: drawn, or empty below a covered parent. */
  coveredFrame: number;
  /** Projected spacing (device px) and distance (m) from the last evaluation. */
  projectedSpacing: number;
  viewDistance: number;
  /** Octants (bit = x | y << 1 | z << 2, CRS axes) whose child is drawn this frame. */
  childMask: number;
  /** True for ancestors added because the octree skipped them (no points). */
  virtual: boolean;
}

export interface SceneFrameCenter {
  x: number;
  y: number;
  z: number;
}

/** Renderer side of the residency contract. */
export interface SceneNodeUploader {
  /** Uploads a node block; returns false if the GPU refused it (out of memory). */
  uploadNode(node: SceneNode, block: ArrayBuffer): boolean;
  releaseNode(node: SceneNode): void;
}

export interface SceneLodStats {
  selectedNodes: number;
  selectedPoints: number;
  /** Points of the target selection, including nodes still loading. */
  targetPoints: number;
  residentNodes: number;
  residentPoints: number;
  pendingLoads: number;
  /** Node blocks uploaded since the scene opened (reloads after eviction included). */
  uploadedNodes: number;
  totalPoints: number;
  totalNodes: number;
  pointBudget: number;
  poolBudget: number;
  frustumCulled: number;
}

/** Max-heap of node ids keyed by rank, on typed arrays (no allocation per push). */
class NodeHeap {
  private ids = new Int32Array(256);
  private keys = new Float64Array(256);
  size = 0;
  /** Key of the id returned by the last `pop()`. */
  topKey = 0;

  clear(): void {
    this.size = 0;
  }

  push(id: number, key: number): void {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2);
      ids.set(this.ids);
      this.ids = ids;
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
    }
    const ids = this.ids;
    const keys = this.keys;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! >= key) break;
      ids[i] = ids[parent]!;
      keys[i] = keys[parent]!;
      i = parent;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0]!;
    this.topKey = keys[0]!;
    const n = --this.size;
    if (n > 0) {
      const id = ids[n]!;
      const key = keys[n]!;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        if (left >= n) break;
        const right = left + 1;
        const child = right < n && keys[right]! > keys[left]! ? right : left;
        if (keys[child]! <= key) break;
        ids[i] = ids[child]!;
        keys[i] = keys[child]!;
        i = child;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}

interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

function octantOf(entry: Pick<LodNode, 'x' | 'y' | 'z'>): number {
  return (entry.x & 1) | ((entry.y & 1) << 1) | ((entry.z & 1) << 2);
}

/** Shrinks `node` to its intersection with `box`; returns whether it changed. */
function clipNode(node: SceneNode, box: Box): boolean {
  let changed = false;
  if (box.minX > node.minX && box.minX <= node.maxX) { node.minX = box.minX; changed = true; }
  if (box.maxX < node.maxX && box.maxX >= node.minX) { node.maxX = box.maxX; changed = true; }
  if (box.minY > node.minY && box.minY <= node.maxY) { node.minY = box.minY; changed = true; }
  if (box.maxY < node.maxY && box.maxY >= node.minY) { node.maxY = box.maxY; changed = true; }
  if (box.minZ > node.minZ && box.minZ <= node.maxZ) { node.minZ = box.minZ; changed = true; }
  if (box.maxZ < node.maxZ && box.maxZ >= node.minZ) { node.maxZ = box.maxZ; changed = true; }
  return changed;
}

export class SceneLod {
  readonly nodes: SceneNode[] = [];
  private readonly tiles: OpenedLodTile[];
  private readonly roots: number[] = [];
  private readonly uploader: SceneNodeUploader;
  private readonly onNodeResident: () => void;

  private frameIndex = 0;
  private selected: SceneNode[] = [];
  private targetPoints = 0;
  private readonly heap = new NodeHeap();
  private readonly pending = new Map<number, number>();
  /** Scratch of `pumpLoads` (no allocation per frame): pending ids, and their rank by node id. */
  private readonly loadQueue: number[] = [];
  private pendingRank = new Float64Array(0);
  private inFlight = 0;
  private residentPoints = 0;
  private residentNodes = 0;
  /** Points/nodes of loads in flight, reserved so concurrent loads cannot overshoot the pool. */
  private reservedPoints = 0;
  private reservedNodes = 0;
  /** Eviction candidates (least recently selected first), built at most once per load pump. */
  private evictionQueue: SceneNode[] | null = null;
  private evictionCursor = 0;
  private pointBudget: number;
  private poolBudget: number;
  private readonly maxResidentNodes: number;
  private frustumCulled = 0;
  private uploadedNodes = 0;
  private destroyed = false;
  readonly totalPoints: number;

  constructor(
    tiles: OpenedLodTile[],
    center: SceneFrameCenter,
    options: {
      pointBudget: number;
      /** Points kept resident on the GPU. */
      poolBudget: number;
      /** Nodes the GPU pool can hold at once. */
      maxResidentNodes: number;
      uploader: SceneNodeUploader;
      /** A node finished loading (or failed): the caller should render again. */
      onNodeResident: () => void;
    },
  ) {
    this.tiles = tiles;
    this.uploader = options.uploader;
    this.onNodeResident = options.onNodeResident;
    this.pointBudget = options.pointBudget;
    this.poolBudget = Math.max(options.poolBudget, options.pointBudget);
    this.maxResidentNodes = Math.max(1, options.maxResidentNodes);
    let total = 0;
    tiles.forEach((tile, tileIndex) => {
      total += tile.header.pointCount;
      this.addTile(tile, tileIndex, center);
    });
    this.totalPoints = total;
    this.pendingRank = new Float64Array(this.nodes.length);
  }

  private createNode(
    tileIndex: number,
    entry: LodNode,
    center: SceneFrameCenter,
    tileBox: Box,
    virtual: boolean,
  ): SceneNode {
    const tile = this.tiles[tileIndex]!;
    const header = tile.header;
    const cube = lodNodeCube(header, entry);
    // Absolute cube corner → render frame (float64 subtraction, exact enough).
    const minX = header.origin.x + cube.minX - center.x;
    const minY = header.origin.z + cube.minZ - center.z;
    const maxZ = -(header.origin.y + cube.minY - center.y);
    const size = cube.size;
    const cell = lodNodeSpacing(header, entry.depth);
    const node: SceneNode = {
      id: this.nodes.length,
      tileIndex,
      entry,
      depth: entry.depth,
      minX, minY, minZ: maxZ - size,
      maxX: minX + size, maxY: minY + size, maxZ,
      originX: minX, originY: minY, originZ: maxZ,
      size,
      cell,
      // Leaves keep every remaining point, so they are denser than their
      // level's nominal spacing: estimate it from the count (surface data).
      spacing: entry.count > 0 ? Math.min(cell, size / Math.sqrt(entry.count)) : cell,
      adaptiveSpacing: 0,
      parent: -1,
      children: [],
      state: virtual ? 'resident' : 'idle',
      lastSelectedFrame: -1,
      lastDrawnFrame: -1,
      refinedFrame: -1,
      coveredFrame: -1,
      projectedSpacing: 0,
      viewDistance: 0,
      childMask: 0,
      virtual,
    };
    clipNode(node, tileBox);
    this.nodes.push(node);
    return node;
  }

  private addTile(tile: OpenedLodTile, tileIndex: number, center: SceneFrameCenter): void {
    const b = tile.header.bounds;
    const e = TILE_BOUNDS_EPSILON;
    const tileBox: Box = {
      minX: b.minX - center.x - e, maxX: b.maxX - center.x + e,
      minY: b.minZ - center.z - e, maxY: b.maxZ - center.z + e,
      minZ: -(b.maxY - center.y) - e, maxZ: -(b.minY - center.y) + e,
    };
    const byKey = new Map<string, SceneNode>();
    const keyOf = (d: number, x: number, y: number, z: number) => `${d}-${x}-${y}-${z}`;
    for (const entry of tile.nodes) {
      byKey.set(keyOf(entry.depth, entry.x, entry.y, entry.z), this.createNode(tileIndex, entry, center, tileBox, false));
    }
    // Link parents, creating empty ancestors the octree may have omitted.
    const ensure = (d: number, x: number, y: number, z: number): SceneNode => {
      const key = keyOf(d, x, y, z);
      let node = byKey.get(key);
      if (!node) {
        node = this.createNode(tileIndex, { depth: d, x, y, z, count: 0, byteOffset: 0 }, center, tileBox, true);
        byKey.set(key, node);
        if (d > 0) {
          const parent = ensure(d - 1, x >> 1, y >> 1, z >> 1);
          node.parent = parent.id;
          parent.children.push(node.id);
        }
      }
      return node;
    };
    for (const node of [...byKey.values()]) {
      if (node.depth === 0 || node.parent >= 0) continue;
      const entry = node.entry;
      const parent = ensure(entry.depth - 1, entry.x >> 1, entry.y >> 1, entry.z >> 1);
      node.parent = parent.id;
      parent.children.push(node.id);
    }
    for (const node of byKey.values()) {
      node.adaptiveSpacing = node.children.length > 0 ? node.spacing : 0;
    }
    const root = byKey.get(keyOf(0, 0, 0, 0));
    if (root) this.roots.push(root.id);
  }

  setPointBudget(points: number): void {
    this.pointBudget = Math.max(1, Math.floor(points));
  }

  setPoolBudget(points: number): void {
    this.poolBudget = Math.max(points, this.pointBudget);
  }

  /** Resident nodes to draw this frame, front to back. Valid until the next `update`. */
  getSelectedNodes(): readonly SceneNode[] {
    return this.selected;
  }

  /** No load is pending or running: the current selection is final. */
  isIdle(): boolean {
    return this.pending.size === 0 && this.inFlight === 0;
  }

  getStats(): SceneLodStats {
    let selectedPoints = 0;
    for (const node of this.selected) selectedPoints += node.entry.count;
    return {
      selectedNodes: this.selected.length,
      selectedPoints,
      targetPoints: this.targetPoints,
      residentNodes: this.residentNodes,
      residentPoints: this.residentPoints,
      pendingLoads: this.pending.size + this.inFlight,
      uploadedNodes: this.uploadedNodes,
      totalPoints: this.totalPoints,
      totalNodes: this.nodes.length,
      pointBudget: this.pointBudget,
      poolBudget: this.poolBudget,
      frustumCulled: this.frustumCulled,
    };
  }

  /**
   * Sets the node's projected spacing and view distance; returns its rank:
   * that spacing weighted by the square root of the foreshortening of its
   * bounds, i.e. their projected area along the view ray over their
   * footprint (1 seen from above or face-on, → height/width at grazing
   * angles for a flat patch; boxes as tall as wide stay at 1).
   */
  private evaluate(node: SceneNode, camX: number, camY: number, camZ: number, focalPx: number): number {
    const dx = (camX < node.minX ? node.minX : camX > node.maxX ? node.maxX : camX) - camX;
    const dy = (camY < node.minY ? node.minY : camY > node.maxY ? node.maxY : camY) - camY;
    const dz = (camZ < node.minZ ? node.minZ : camZ > node.maxZ ? node.maxZ : camZ) - camZ;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const projected = (node.spacing * focalPx) / Math.max(distance, MIN_VIEW_DISTANCE);
    node.viewDistance = distance;
    node.projectedSpacing = projected;
    if (distance < MIN_VIEW_DISTANCE) return projected;
    const ex = node.maxX - node.minX;
    const ey = node.maxY - node.minY;
    const ez = node.maxZ - node.minZ;
    const footprint = ex * ez;
    if (footprint <= 0) return projected;
    const ratio = (Math.abs(dy) * footprint + (Math.abs(dx) * ez + Math.abs(dz) * ex) * ey) / (distance * footprint);
    return projected * Math.sqrt(ratio >= 1 ? 1 : ratio <= MIN_FORESHORTENING ? MIN_FORESHORTENING : ratio);
  }

  /**
   * Selects the nodes to draw for this camera.
   * @param projScaleY projection `proj[1][1]` (focal), see `screenSpaceSize`.
   */
  update(viewProj: Float32Array, projScaleY: number, camX: number, camY: number, camZ: number, viewportH: number): void {
    if (this.destroyed) return;
    const frame = ++this.frameIndex;
    const previousFrame = frame - 1;
    const focalPx = Math.abs(projScaleY) * viewportH * 0.5;
    const planes = extractFrustumPlanes(viewProj);
    const heap = this.heap;
    const nodes = this.nodes;
    this.frustumCulled = 0;
    this.pending.clear();
    heap.clear();

    // Visible tile roots come first and always fit: whatever the angle and
    // the budget, every tile on screen shows at least its coarsest level.
    for (const rootId of this.roots) {
      const root = nodes[rootId]!;
      if (frustumTestAABB(planes, root) === OUTSIDE) {
        this.frustumCulled++;
        continue;
      }
      this.evaluate(root, camX, camY, camZ, focalPx);
      heap.push(rootId, Infinity);
    }

    const selected = this.selected;
    selected.length = 0;
    const budget = this.pointBudget;
    let charged = 0;
    while (heap.size > 0) {
      const id = heap.pop();
      const node = nodes[id]!;
      if (node.state === 'failed') continue;
      // Drawn only below a drawn parent, so the screen always fills coarse to fine.
      const parentCovered = node.parent < 0 || nodes[node.parent]!.coveredFrame === frame;
      const count = node.entry.count;
      if (count > 0) {
        const limit = node.lastSelectedFrame === previousFrame ? budget : budget * NEW_NODE_BUDGET_SHARE;
        if (node.parent >= 0 && charged + count > limit) continue;
        charged += count;
        node.lastSelectedFrame = frame;
        if (node.state === 'resident' && parentCovered) {
          selected.push(node);
          node.lastDrawnFrame = frame;
          node.coveredFrame = frame;
        } else if (node.state === 'idle') {
          this.pending.set(id, heap.topKey);
          this.pendingRank[id] = heap.topKey;
        }
      } else {
        node.lastSelectedFrame = frame;
        if (parentCovered) node.coveredFrame = frame;
      }
      // Hysteresis: a refined node stays refined until its spacing is clearly fine enough.
      const threshold = node.refinedFrame === previousFrame ? TARGET_SPACING_PX * UNREFINE_FACTOR : TARGET_SPACING_PX;
      if (node.projectedSpacing <= threshold) continue;
      node.refinedFrame = frame;
      for (const childId of node.children) {
        const child = nodes[childId]!;
        if (frustumTestAABB(planes, child) === OUTSIDE) {
          this.frustumCulled++;
          continue;
        }
        const rank = this.evaluate(child, camX, camY, camZ, focalPx);
        heap.push(childId, child.lastSelectedFrame === previousFrame ? rank * KEEP_PRIORITY_BOOST : rank);
      }
    }
    this.targetPoints = charged;

    // Octants covered by a drawn child (or by an empty child refined further):
    // the node's own points there are not the finest on screen.
    for (const node of selected) {
      let mask = 0;
      for (const childId of node.children) {
        const child = nodes[childId]!;
        const covered = child.entry.count > 0
          ? child.lastDrawnFrame === frame
          : child.coveredFrame === frame && child.refinedFrame === frame;
        if (covered) mask |= 1 << octantOf(child.entry);
      }
      node.childMask = mask;
    }

    // Front to back: opaque sprites then reject hidden fragments early.
    selected.sort((a, b) => a.viewDistance - b.viewDistance);
    this.pumpLoads();
  }

  private pumpLoads(): void {
    if (this.inFlight >= MAX_CONCURRENT_LOADS || this.pending.size === 0) return;
    this.evictionQueue = null;
    // Highest rank first; the heap mostly pops in that order already, which
    // the sort exploits.
    const queue = this.loadQueue;
    const rank = this.pendingRank;
    queue.length = 0;
    for (const id of this.pending.keys()) queue.push(id);
    queue.sort((a, b) => rank[b]! - rank[a]!);
    for (const id of queue) {
      if (this.inFlight >= MAX_CONCURRENT_LOADS) break;
      const node = this.nodes[id]!;
      if (node.state !== 'idle') {
        this.pending.delete(id);
        continue;
      }
      // Coarse to fine: a node waits for its parent's points, which tighten its bounds.
      const parent = node.parent >= 0 ? this.nodes[node.parent]! : null;
      if (parent && parent.entry.count > 0 && parent.state !== 'resident') continue;
      if (!this.makeRoom(node.entry.count)) break;
      this.pending.delete(id);
      this.startLoad(node);
    }
  }

  private fits(points: number): boolean {
    return this.residentPoints + this.reservedPoints + points <= this.poolBudget
      && this.residentNodes + this.reservedNodes < this.maxResidentNodes;
  }

  /** Evicts least-recently selected nodes until one more node of `points` fits in the pool. */
  private makeRoom(points: number): boolean {
    if (this.fits(points)) return true;
    if (!this.evictionQueue) {
      const frame = this.frameIndex;
      this.evictionQueue = this.nodes
        .filter((node) => node.state === 'resident' && !node.virtual && node.depth > 0 && node.lastSelectedFrame < frame)
        .sort((a, b) => a.lastSelectedFrame - b.lastSelectedFrame || b.depth - a.depth);
      this.evictionCursor = 0;
    }
    const queue = this.evictionQueue;
    while (!this.fits(points) && this.evictionCursor < queue.length) {
      const node = queue[this.evictionCursor++]!;
      if (node.state === 'resident' && node.lastSelectedFrame < this.frameIndex) this.evict(node);
    }
    return this.fits(points);
  }

  private evict(node: SceneNode): void {
    this.uploader.releaseNode(node);
    node.state = 'idle';
    this.residentPoints -= node.entry.count;
    this.residentNodes--;
  }

  /** Shrinks the bounds of `node` and its subtree to the node's points (plus the margin). */
  private tightenToContent(node: SceneNode, block: ArrayBuffer): void {
    const count = node.entry.count;
    const words = new Uint16Array(block, 0, (count * LOD_POINT_STRIDE) >> 1);
    const step = LOD_POINT_STRIDE >> 1;
    let minQx = 65535, minQy = 65535, minQz = 65535;
    let maxQx = 0, maxQy = 0, maxQz = 0;
    for (let i = 0, end = count * step; i < end; i += step) {
      const qx = words[i]!, qy = words[i + 1]!, qz = words[i + 2]!;
      if (qx < minQx) minQx = qx;
      if (qx > maxQx) maxQx = qx;
      if (qy < minQy) minQy = qy;
      if (qy > maxQy) maxQy = qy;
      if (qz < minQz) minQz = qz;
      if (qz > maxQz) maxQz = qz;
    }
    const s = node.size / 65535;
    const margin = CONTENT_MARGIN_CELLS * node.cell;
    // Quantized CRS axes (east, north, up) → render frame (east, up, −north).
    const box: Box = {
      minX: node.originX + minQx * s - margin,
      maxX: node.originX + maxQx * s + margin,
      minY: node.originY + minQz * s - margin,
      maxY: node.originY + maxQz * s + margin,
      minZ: node.originZ - maxQy * s - margin,
      maxZ: node.originZ - minQy * s + margin,
    };
    if (!clipNode(node, box)) return;
    // Every descendant lies inside the node's new bounds too.
    const stack = [...node.children];
    while (stack.length > 0) {
      const child = this.nodes[stack.pop()!]!;
      if (clipNode(child, node)) stack.push(...child.children);
    }
  }

  private startLoad(node: SceneNode): void {
    node.state = 'loading';
    this.inFlight++;
    this.reservedPoints += node.entry.count;
    this.reservedNodes++;
    const tile = this.tiles[node.tileIndex]!;
    readLodNodeBlock(tile, node.entry)
      .then((block) => {
        if (this.destroyed || node.state !== 'loading') return;
        if (block.byteLength >= node.entry.count * LOD_POINT_STRIDE) this.tightenToContent(node, block);
        if (this.uploader.uploadNode(node, block)) {
          node.state = 'resident';
          this.residentPoints += node.entry.count;
          this.residentNodes++;
          this.uploadedNodes++;
          // Its children were queued against looser bounds: the next update
          // ranks them again before any of them is read.
          for (const childId of node.children) this.pending.delete(childId);
        } else {
          node.state = 'failed';
        }
      })
      .catch((error) => {
        console.warn('[LiDAR LOD] Node read failed:', error);
        if (node.state === 'loading') node.state = 'failed';
      })
      .finally(() => {
        this.inFlight--;
        this.reservedPoints -= node.entry.count;
        this.reservedNodes--;
        if (this.destroyed) return;
        this.onNodeResident();
        this.pumpLoads();
      });
  }

  destroy(): void {
    this.destroyed = true;
    for (const node of this.nodes) {
      if (node.state === 'resident' && !node.virtual) this.uploader.releaseNode(node);
    }
    this.selected = [];
    this.pending.clear();
  }
}
