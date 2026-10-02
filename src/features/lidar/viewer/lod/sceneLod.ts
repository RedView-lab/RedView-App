// ============================================
// Scene LOD: multi-tile additive octrees, streamed and budgeted
// ============================================
//
// Every tile is an additive octree (see lodTile.ts) whose node blocks live
// in the OPFS LOD cache. Each frame:
//  1. nodes are visited by priority (projected point spacing, largest first)
//     and selected while they fit in the point budget; a node is refined
//     while its spacing projects to more than `TARGET_SPACING_PX`;
//  2. selected nodes that are not resident are queued for loading (read from
//     the cache, uploaded by the renderer) — their subtree waits for them;
//  3. residency is bounded by a pool budget; least-recently selected nodes
//     are evicted first.
// The camera always gets full density nearby and coarser levels far away,
// whatever the number of tiles: nothing is decimated up front.

import { readLodNodeBlock, type OpenedLodTile } from '../../lib/lodCache';
import { extractFrustumPlanes, frustumTestAABB, OUTSIDE, type FrustumPlanes } from './frustum';
import { lodNodeCube, lodNodeSpacing, type LodNode } from './lodTile';

/** Refine while a node's point spacing projects to more than this (device px). */
const TARGET_SPACING_PX = 1.25;
/** A refined node only collapses once its spacing drops below this fraction of the target. */
const UNREFINE_FACTOR = 0.7;
/** Nodes drawn last frame are visited earlier… */
const KEEP_PRIORITY_BOOST = 1.3;
/** …and may overshoot the point budget by this factor before being dropped. */
const BUDGET_KEEP_SLACK = 1.1;
const MAX_CONCURRENT_LOADS = 6;

export type SceneNodeState = 'idle' | 'loading' | 'resident' | 'failed';

export interface SceneNode {
  id: number;
  tileIndex: number;
  entry: LodNode;
  depth: number;
  /** Render-frame AABB (x east, y up, z = −north), relative to the scene centre. */
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  centerX: number; centerY: number; centerZ: number;
  radius: number;
  /**
   * Render-frame position of the quantization cube's min corner:
   * renderPos = origin + (qx·s, qz·s, −qy·s), q ∈ [0, 1].
   */
  originX: number; originY: number; originZ: number;
  size: number;
  spacing: number;
  parent: number;
  children: number[];
  state: SceneNodeState;
  lastSelectedFrame: number;
  /** Last frame the node was drawn (hysteresis against frame-to-frame swaps). */
  lastDrawnFrame: number;
  /** Last frame the node's children were visited (refinement hysteresis). */
  refinedFrame: number;
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
  residentNodes: number;
  residentPoints: number;
  pendingLoads: number;
  totalPoints: number;
  totalNodes: number;
  pointBudget: number;
  poolBudget: number;
  frustumCulled: number;
}

class NodeHeap {
  private items: { id: number; priority: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }

  push(id: number, priority: number): void {
    const items = this.items;
    items.push({ id, priority });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]!.priority >= items[i]!.priority) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }

  pop(): { id: number; priority: number } {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let best = i;
        if (left < items.length && items[left]!.priority > items[best]!.priority) best = left;
        if (right < items.length && items[right]!.priority > items[best]!.priority) best = right;
        if (best === i) break;
        [items[best], items[i]] = [items[i]!, items[best]!];
        i = best;
      }
    }
    return top;
  }
}

export class SceneLod {
  readonly nodes: SceneNode[] = [];
  private readonly tiles: OpenedLodTile[];
  private readonly roots: number[] = [];
  private readonly uploader: SceneNodeUploader;
  private readonly onNodeResident: () => void;

  private frameIndex = 0;
  private selected: SceneNode[] = [];
  private readonly heap = new NodeHeap();
  private readonly pending = new Map<number, number>();
  private inFlight = 0;
  private residentPoints = 0;
  private residentNodes = 0;
  /** Points/nodes of loads in flight, reserved so concurrent loads cannot overshoot the pool. */
  private reservedPoints = 0;
  private reservedNodes = 0;
  private pointBudget: number;
  private poolBudget: number;
  private readonly maxResidentNodes: number;
  private planes: FrustumPlanes | null = null;
  private frustumCulled = 0;
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
  }

  private createNode(
    tileIndex: number,
    entry: LodNode,
    center: SceneFrameCenter,
    virtual: boolean,
  ): SceneNode {
    const tile = this.tiles[tileIndex]!;
    const header = tile.header;
    const cube = lodNodeCube(header, entry);
    // Absolute cube corner → render frame (float64 subtraction, exact enough).
    const absMinX = header.origin.x + cube.minX;
    const absMinY = header.origin.y + cube.minY;
    const absMinZ = header.origin.z + cube.minZ;
    const minX = absMinX - center.x;
    const minY = absMinZ - center.z;
    const maxZ = -(absMinY - center.y);
    const size = cube.size;
    const node: SceneNode = {
      id: this.nodes.length,
      tileIndex,
      entry,
      depth: entry.depth,
      minX, minY, minZ: maxZ - size,
      maxX: minX + size, maxY: minY + size, maxZ,
      centerX: minX + size / 2, centerY: minY + size / 2, centerZ: maxZ - size / 2,
      radius: (Math.sqrt(3) * size) / 2,
      originX: minX, originY: minY, originZ: maxZ,
      size,
      // Leaves keep every remaining point, so they are denser than their
      // level's nominal spacing: estimate it from the count (surface data).
      spacing: entry.count > 0
        ? Math.min(lodNodeSpacing(header, entry.depth), size / Math.sqrt(entry.count))
        : lodNodeSpacing(header, entry.depth),
      parent: -1,
      children: [],
      state: virtual ? 'resident' : 'idle',
      lastSelectedFrame: -1,
      lastDrawnFrame: -1,
      refinedFrame: -1,
      virtual,
    };
    this.nodes.push(node);
    return node;
  }

  private addTile(tile: OpenedLodTile, tileIndex: number, center: SceneFrameCenter): void {
    const byKey = new Map<string, SceneNode>();
    const keyOf = (d: number, x: number, y: number, z: number) => `${d}-${x}-${y}-${z}`;
    for (const entry of tile.nodes) {
      byKey.set(keyOf(entry.depth, entry.x, entry.y, entry.z), this.createNode(tileIndex, entry, center, false));
    }
    // Link parents, creating empty ancestors the octree may have omitted.
    const ensure = (d: number, x: number, y: number, z: number): SceneNode => {
      const key = keyOf(d, x, y, z);
      let node = byKey.get(key);
      if (!node) {
        node = this.createNode(tileIndex, { depth: d, x, y, z, count: 0, byteOffset: 0 }, center, true);
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
      const e = node.entry;
      const parent = ensure(e.depth - 1, e.x >> 1, e.y >> 1, e.z >> 1);
      node.parent = parent.id;
      parent.children.push(node.id);
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
      residentNodes: this.residentNodes,
      residentPoints: this.residentPoints,
      pendingLoads: this.pending.size + this.inFlight,
      totalPoints: this.totalPoints,
      totalNodes: this.nodes.length,
      pointBudget: this.pointBudget,
      poolBudget: this.poolBudget,
      frustumCulled: this.frustumCulled,
    };
  }

  private priorityOf(node: SceneNode, camX: number, camY: number, camZ: number, focalPx: number): number {
    const dx = node.centerX - camX;
    const dy = node.centerY - camY;
    const dz = node.centerZ - camZ;
    const distance = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz) - node.radius);
    return (node.spacing * focalPx) / distance;
  }

  /**
   * Selects the nodes to draw for this camera.
   * @param projScaleY projection `proj[1][1]` (focal), see `screenSpaceSize`.
   */
  update(viewProj: Float32Array, projScaleY: number, camX: number, camY: number, camZ: number, viewportH: number): void {
    if (this.destroyed) return;
    this.frameIndex++;
    const frame = this.frameIndex;
    const focalPx = Math.abs(projScaleY) * viewportH * 0.5;
    this.planes = extractFrustumPlanes(viewProj);
    this.frustumCulled = 0;
    this.pending.clear();
    this.heap.clear();

    for (const rootId of this.roots) {
      const root = this.nodes[rootId]!;
      if (frustumTestAABB(this.planes, root) === OUTSIDE) {
        this.frustumCulled++;
        continue;
      }
      this.heap.push(rootId, this.priorityOf(root, camX, camY, camZ, focalPx));
    }

    const selected: SceneNode[] = [];
    let selectedPoints = 0;
    const previousFrame = frame - 1;
    while (this.heap.size > 0) {
      const { id } = this.heap.pop();
      const node = this.nodes[id]!;
      const priority = this.priorityOf(node, camX, camY, camZ, focalPx);
      const wasDrawn = node.lastDrawnFrame === previousFrame;
      if (node.entry.count > 0) {
        // Hysteresis: what was on screen may overshoot the budget slightly
        // rather than trade places with a new candidate every frame.
        const budget = wasDrawn ? this.pointBudget * BUDGET_KEEP_SLACK : this.pointBudget;
        if (selectedPoints + node.entry.count > budget && selected.length > 0) continue;
        if (node.state !== 'resident') {
          if (node.state === 'idle') this.pending.set(id, priority);
          continue;
        }
        selected.push(node);
        selectedPoints += node.entry.count;
        node.lastDrawnFrame = frame;
      }
      node.lastSelectedFrame = frame;
      // Hysteresis: a refined node stays refined until its spacing is clearly fine enough.
      const refineThreshold = node.refinedFrame === previousFrame ? TARGET_SPACING_PX * UNREFINE_FACTOR : TARGET_SPACING_PX;
      if (priority <= refineThreshold) continue;
      node.refinedFrame = frame;
      for (const childId of node.children) {
        const child = this.nodes[childId]!;
        if (frustumTestAABB(this.planes, child) === OUTSIDE) {
          this.frustumCulled++;
          continue;
        }
        const childPriority = this.priorityOf(child, camX, camY, camZ, focalPx);
        this.heap.push(childId, child.lastDrawnFrame === previousFrame ? childPriority * KEEP_PRIORITY_BOOST : childPriority);
      }
    }

    // Front to back: opaque sprites then reject hidden fragments early.
    selected.sort((a, b) => {
      const da = (a.centerX - camX) ** 2 + (a.centerY - camY) ** 2 + (a.centerZ - camZ) ** 2;
      const db = (b.centerX - camX) ** 2 + (b.centerY - camY) ** 2 + (b.centerZ - camZ) ** 2;
      return da - db;
    });
    this.selected = selected;
    this.pumpLoads();
  }

  private pumpLoads(): void {
    if (this.inFlight >= MAX_CONCURRENT_LOADS || this.pending.size === 0) return;
    const queue = [...this.pending.entries()].sort((a, b) => b[1] - a[1]);
    for (const [id] of queue) {
      if (this.inFlight >= MAX_CONCURRENT_LOADS) break;
      const node = this.nodes[id]!;
      if (node.state !== 'idle') continue;
      this.pending.delete(id);
      if (!this.makeRoom(node.entry.count)) break;
      this.startLoad(node);
    }
  }

  /** Evicts least-recently selected nodes until one more node of `points` fits in the pool. */
  private makeRoom(points: number): boolean {
    const fits = () => this.residentPoints + this.reservedPoints + points <= this.poolBudget
      && this.residentNodes + this.reservedNodes < this.maxResidentNodes;
    if (fits()) return true;
    const candidates = this.nodes
      .filter((node) => node.state === 'resident' && !node.virtual && node.lastSelectedFrame < this.frameIndex)
      .sort((a, b) => a.lastSelectedFrame - b.lastSelectedFrame || b.depth - a.depth);
    for (const node of candidates) {
      if (fits()) break;
      this.evict(node);
    }
    return fits();
  }

  private evict(node: SceneNode): void {
    this.uploader.releaseNode(node);
    node.state = 'idle';
    this.residentPoints -= node.entry.count;
    this.residentNodes--;
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
        if (this.uploader.uploadNode(node, block)) {
          node.state = 'resident';
          this.residentPoints += node.entry.count;
          this.residentNodes++;
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
