// ============================================
// Octree LOD — Manager
// ============================================

import type { SerializedNode, VisibleNode, CameraState, FlatOctree } from './types';
import {
  MIN_NODE_SIZE_PX,
  HYSTERESIS_FACTOR,
  TEMPORAL_POS_THRESHOLD,
  TEMPORAL_ROT_THRESHOLD,
  INITIAL_POINT_BUDGET,
  MIN_POINT_BUDGET,
  MAX_POINT_BUDGET,
  FRAME_WINDOW,
  TARGET_FRAME_MS,
  OCCUPANCY_GRID_SIZE,
} from './types';
import {
  extractFrustumPlanes,
  frustumTestAABB,
  screenSpaceSize,
  OUTSIDE,
  INSIDE,
  type FrustumPlanes,
} from './frustum';

export class LodManager {
  private octree: FlatOctree | null = null;
  private visibleNodes: VisibleNode[] = [];
  private visiblePointCount = 0;

  density = 1.0;

  private refinedLastFrame = new Set<number>();
  private refinedThisFrame = new Set<number>();
  private refinedSpare = new Set<number>();

  private lastCamera: CameraState | null = null;
  private cacheValid = false;

  private pointBudget = INITIAL_POINT_BUDGET;
  private frameTimes: number[] = [];
  private frameIdx = 0;
  private slowFrameCount = 0;
  private fastFrameCount = 0;

  voxelMinDepth = 0;
  private rootExtent = 1;

  stats = {
    visiblePoints: 0,
    totalPoints: 0,
    visibleNodes: 0,
    totalNodes: 0,
    pointBudget: INITIAL_POINT_BUDGET,
    fps: 60,
    maxDepth: 0,
    voxelSamples: 0,
    frustumCulled: 0,
    lodSkipped: 0,
  };

  setOctree(octree: FlatOctree) {
    this.octree = octree;
    this.refinedLastFrame.clear();
    this.lastCamera = null;
    this.cacheValid = false;
    this.stats.totalPoints = octree.totalLeafPoints;
    this.stats.totalNodes = octree.nodeCount;
    this.stats.maxDepth = octree.maxDepthReached;
    this.stats.voxelSamples = octree.totalVoxelSamples;

    const r = octree.root.aabb;
    this.rootExtent = Math.max(r.maxX - r.minX, r.maxY - r.minY, r.maxZ - r.minZ);
  }

  getVoxelPointSize(basePointSize: number): number {
    if (!this.octree || this.voxelMinDepth >= this.octree.maxDepthReached) return basePointSize;
    const gridSize = OCCUPANCY_GRID_SIZE;
    const nodeSize = this.rootExtent / Math.pow(2, this.voxelMinDepth);
    const cellSize = nodeSize / gridSize;
    const maxVoxelSize = basePointSize * 3;
    return Math.min(maxVoxelSize, Math.max(basePointSize, cellSize * 1.3));
  }

  getVisibleNodes(): VisibleNode[] {
    return this.visibleNodes;
  }

  getVisiblePointCount(): number {
    return this.visiblePointCount;
  }

  getPointBudget(): number {
    return this.pointBudget;
  }

  update(
    viewProj: Float32Array,
    camPosX: number, camPosY: number, camPosZ: number,
    camFwdX: number, camFwdY: number, camFwdZ: number,
    viewportW: number, viewportH: number,
    deltaMs: number,
  ): void {
    if (!this.octree) return;

    this.updateBudget(deltaMs);

    if (this.checkTemporalCoherence(camPosX, camPosY, camPosZ, camFwdX, camFwdY, camFwdZ)) {
      this.enforceBudget();
      return;
    }

    const planes = extractFrustumPlanes(viewProj);

    const recycled = this.refinedSpare;
    this.refinedSpare = this.refinedLastFrame;
    this.refinedLastFrame = this.refinedThisFrame;
    recycled.clear();
    this.refinedThisFrame = recycled;

    this.visibleNodes.length = 0;
    this.visiblePointCount = 0;
    this.voxelMinDepth = this.octree.maxDepthReached;
    this.stats.frustumCulled = 0;
    this.stats.lodSkipped = 0;

    this.collectVisible(this.octree.root, planes, viewProj, viewportW, viewportH, true);

    this.enforceBudget();

    this.stats.visiblePoints = this.visiblePointCount;
    this.stats.visibleNodes = this.visibleNodes.length;
    this.stats.pointBudget = this.pointBudget;

    if (!this.lastCamera) {
      this.lastCamera = { posX: camPosX, posY: camPosY, posZ: camPosZ, fwdX: camFwdX, fwdY: camFwdY, fwdZ: camFwdZ };
    } else {
      this.lastCamera.posX = camPosX; this.lastCamera.posY = camPosY; this.lastCamera.posZ = camPosZ;
      this.lastCamera.fwdX = camFwdX; this.lastCamera.fwdY = camFwdY; this.lastCamera.fwdZ = camFwdZ;
    }
    this.cacheValid = true;
  }

  private collectVisible(
    node: SerializedNode,
    planes: FrustumPlanes,
    viewProj: Float32Array,
    vpW: number,
    vpH: number,
    testFrustum: boolean,
  ): void {
    if (node.subtreePointCount === 0 && node.voxelCount === 0) return;

    if (testFrustum) {
      const result = frustumTestAABB(planes, node.aabb);
      if (result === OUTSIDE) {
        this.stats.frustumCulled++;
        return;
      }
      if (result === INSIDE) {
        testFrustum = false;
      }
    }

    const ss = screenSpaceSize(node.aabb, viewProj, vpW, vpH);

    let threshold = MIN_NODE_SIZE_PX;
    if (this.refinedLastFrame.has(node.id)) {
      threshold *= HYSTERESIS_FACTOR;
    }

    if (node.isLeaf) {
      if (node.pointCount > 0) {
        this.visibleNodes.push({
          offset: node.pointOffset,
          count: node.pointCount,
          isVoxel: false,
          depth: node.depth,
          screenSize: ss,
          density: 1.0,
        });
        this.visiblePointCount += node.pointCount;
      }
      return;
    }

    if (ss < threshold) {
      if (node.voxelCount > 0) {
        this.visibleNodes.push({
          offset: node.voxelOffset,
          count: node.voxelCount,
          isVoxel: true,
          depth: node.depth,
          screenSize: ss,
          density: 1.0,
        });
        this.visiblePointCount += node.voxelCount;
        if (node.depth < this.voxelMinDepth) this.voxelMinDepth = node.depth;
      }
      this.stats.lodSkipped++;
      return;
    }

    this.refinedThisFrame.add(node.id);

    const pointsBefore = this.visiblePointCount;

    for (let i = 0; i < 8; i++) {
      const child = node.children[i];
      if (child) {
        this.collectVisible(child, planes, viewProj, vpW, vpH, testFrustum);
      }
    }

    const childrenContributed = this.visiblePointCount > pointsBefore;

    if (!childrenContributed && node.voxelCount > 0) {
      this.visibleNodes.push({
        offset: node.voxelOffset,
        count: node.voxelCount,
        isVoxel: true,
        depth: node.depth,
        screenSize: ss,
        density: 1.0,
      });
      this.visiblePointCount += node.voxelCount;
      if (node.depth < this.voxelMinDepth) this.voxelMinDepth = node.depth;
    }
  }

  private enforceBudget(): void {
    const nodes = this.visibleNodes;
    const n = nodes.length;

    if (this.visiblePointCount <= this.pointBudget) {
      for (let i = 0; i < n; i++) nodes[i].density = 1.0;
      this.density = 1.0;
      return;
    }

    const order = this.getSortedIndices(nodes);

    let excess = this.visiblePointCount - this.pointBudget;
    for (let i = 0; i < n; i++) {
      const node = nodes[order[i]];
      if (excess <= 0) {
        node.density = 1.0;
        continue;
      }
      const maxRemovable = Math.floor(node.count * 0.60);
      if (maxRemovable <= excess) {
        node.density = 0.40;
        excess -= maxRemovable;
      } else {
        const rawDensity = 1 - excess / node.count;
        node.density = Math.max(0.40, Math.round(rawDensity * 20) / 20);
        excess -= Math.floor(node.count * (1 - node.density));
      }
    }

    this.density = Math.max(0.40, this.pointBudget / this.visiblePointCount);
  }

  private sortBuf: number[] = [];
  private getSortedIndices(nodes: VisibleNode[]): number[] {
    const n = nodes.length;
    const buf = this.sortBuf;
    buf.length = n;
    for (let i = 0; i < n; i++) buf[i] = i;
    buf.sort((a, b) => nodes[a].screenSize - nodes[b].screenSize);
    return buf;
  }

  private checkTemporalCoherence(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
  ): boolean {
    if (!this.cacheValid || !this.lastCamera) return false;

    const lc = this.lastCamera;
    const dx = px - lc.posX, dy = py - lc.posY, dz = pz - lc.posZ;
    const posDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (posDist > TEMPORAL_POS_THRESHOLD) return false;

    const dot = fx * lc.fwdX + fy * lc.fwdY + fz * lc.fwdZ;
    const angle = Math.acos(Math.min(1, Math.max(-1, dot))) * (180 / Math.PI);
    if (angle > TEMPORAL_ROT_THRESHOLD) return false;

    return true;
  }

  private updateBudget(deltaMs: number): void {
    if (this.frameTimes.length < FRAME_WINDOW) {
      this.frameTimes.push(deltaMs);
    } else {
      this.frameTimes[this.frameIdx % FRAME_WINDOW] = deltaMs;
    }
    this.frameIdx++;

    if (this.frameTimes.length < FRAME_WINDOW) return;

    let sum = 0;
    for (let i = 0; i < this.frameTimes.length; i++) sum += this.frameTimes[i];
    const avgMs = sum / this.frameTimes.length;
    this.stats.fps = Math.round(1000 / avgMs);

    if (avgMs > TARGET_FRAME_MS * 1.15) {
      this.slowFrameCount++;
      this.fastFrameCount = 0;
      if (this.slowFrameCount >= 8) {
        this.pointBudget = Math.max(MIN_POINT_BUDGET, Math.floor(this.pointBudget * 0.95));
        this.slowFrameCount = 0;
      }
    } else if (avgMs < TARGET_FRAME_MS * 0.80) {
      this.fastFrameCount++;
      this.slowFrameCount = 0;
      if (this.fastFrameCount >= 4) {
        this.pointBudget = Math.min(MAX_POINT_BUDGET, Math.floor(this.pointBudget * 1.15));
        this.fastFrameCount = 0;
      }
    } else {
      this.slowFrameCount = 0;
      this.fastFrameCount = 0;
    }
  }
}
