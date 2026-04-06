// ============================================
// Octree LOD — Manager
// Smooth cross-fading, proportional budget,
// temporal density smoothing, GPU stochastic discard.
// ============================================

import type { SerializedNode, VisibleNode, CameraState, FlatOctree } from './types';
import {
  LOD_FADE_LOW,
  LOD_FADE_HIGH,
  HYSTERESIS_FACTOR,
  TEMPORAL_POS_THRESHOLD,
  TEMPORAL_ROT_THRESHOLD,
  INITIAL_POINT_BUDGET,
  MIN_POINT_BUDGET,
  MAX_POINT_BUDGET,
  FRAME_WINDOW,
  TARGET_FRAME_MS,
  OCCUPANCY_GRID_SIZE,
  MIN_DENSITY,
  DENSITY_BLEND_RATE,
} from './types';
import {
  extractFrustumPlanes,
  frustumTestAABB,
  screenSpaceSize,
  OUTSIDE,
  INSIDE,
  type FrustumPlanes,
} from './frustum';

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

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

  /** Temporal density smoothing: stores previous frame density per node offset key */
  private prevDensity = new Map<number, number>();
  private prevDensitySwap = new Map<number, number>();

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
    this.prevDensity.clear();
    this.prevDensitySwap.clear();
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
    const maxVoxelSize = basePointSize * (1.5 + this.voxelMinDepth * 0.3);
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
      this.applyTemporalSmoothing();
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
    this.applyTemporalSmoothing();

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

  // ── LOD collection with smooth cross-fade zone ──

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

    // Hysteresis: refined nodes use lower threshold to avoid oscillation
    let fadeLow = LOD_FADE_LOW;
    let fadeHigh = LOD_FADE_HIGH;
    if (this.refinedLastFrame.has(node.id)) {
      fadeLow *= HYSTERESIS_FACTOR;
      fadeHigh *= HYSTERESIS_FACTOR;
    }

    // Leaves always render at full opacity
    if (node.isLeaf) {
      if (node.pointCount > 0) {
        this.visibleNodes.push({
          offset: node.pointOffset,
          count: node.pointCount,
          isVoxel: false,
          depth: node.depth,
          screenSize: ss,
          density: 1.0,
          fadeAlpha: 1.0,
        });
        this.visiblePointCount += node.pointCount;
      }
      return;
    }

    // Below fade zone: render only voxels (coarse LOD)
    if (ss < fadeLow) {
      if (node.voxelCount > 0) {
        this.visibleNodes.push({
          offset: node.voxelOffset,
          count: node.voxelCount,
          isVoxel: true,
          depth: node.depth,
          screenSize: ss,
          density: 1.0,
          fadeAlpha: 1.0,
        });
        this.visiblePointCount += node.voxelCount;
        if (node.depth < this.voxelMinDepth) this.voxelMinDepth = node.depth;
      }
      this.stats.lodSkipped++;
      return;
    }

    // In transition zone [fadeLow, fadeHigh]: render BOTH voxels (fading out)
    // and children (fading in) for smooth cross-fade
    if (ss < fadeHigh && !node.isLeaf) {
      const childAlpha = smoothstep(fadeLow, fadeHigh, ss);   // 0→1 as ss grows
      const voxelAlpha = 1.0 - childAlpha;                     // 1→0 as ss grows

      // Emit fading-out voxels for this node
      if (node.voxelCount > 0 && voxelAlpha > 0.05) {
        this.visibleNodes.push({
          offset: node.voxelOffset,
          count: node.voxelCount,
          isVoxel: true,
          depth: node.depth,
          screenSize: ss,
          density: voxelAlpha,  // GPU stochastic discard handles partial rendering
          fadeAlpha: voxelAlpha,
        });
        this.visiblePointCount += Math.ceil(node.voxelCount * voxelAlpha);
        if (node.depth < this.voxelMinDepth) this.voxelMinDepth = node.depth;
      }

      // Emit fading-in children
      this.refinedThisFrame.add(node.id);
      const pointsBefore = this.visiblePointCount;

      for (let i = 0; i < 8; i++) {
        const child = node.children[i];
        if (child) this.collectVisible(child, planes, viewProj, vpW, vpH, testFrustum);
      }

      // Apply fade alpha to all children just added
      const nodesLen = this.visibleNodes.length;
      if (childAlpha < 0.95) {
        for (let j = nodesLen - 1; j >= 0; j--) {
          const vn = this.visibleNodes[j];
          // Only affect nodes we just added (check if their offset is new)
          if (vn.fadeAlpha === 1.0 && !vn.isVoxel) {
            vn.fadeAlpha = childAlpha;
            vn.density = Math.max(MIN_DENSITY, vn.density * childAlpha);
          } else {
            break; // stop at previously existing entries
          }
        }
      }

      const childrenContributed = this.visiblePointCount > pointsBefore;
      if (!childrenContributed && node.voxelCount > 0 && voxelAlpha <= 0.05) {
        // Fallback: no children contributed, show voxels full
        this.visibleNodes.push({
          offset: node.voxelOffset,
          count: node.voxelCount,
          isVoxel: true,
          depth: node.depth,
          screenSize: ss,
          density: 1.0,
          fadeAlpha: 1.0,
        });
        this.visiblePointCount += node.voxelCount;
        if (node.depth < this.voxelMinDepth) this.voxelMinDepth = node.depth;
      }

      this.stats.lodSkipped++;
      return;
    }

    // Above fade zone: recurse fully into children
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
        fadeAlpha: 1.0,
      });
      this.visiblePointCount += node.voxelCount;
      if (node.depth < this.voxelMinDepth) this.voxelMinDepth = node.depth;
    }
  }

  // ── Proportional budget enforcement ──

  private enforceBudget(): void {
    const nodes = this.visibleNodes;
    const n = nodes.length;

    if (this.visiblePointCount <= this.pointBudget) {
      this.density = 1.0;
      return;
    }

    // Compute average screen size for proportional weighting
    let totalSS = 0;
    let leafPointCount = 0;
    for (let i = 0; i < n; i++) {
      if (!nodes[i].isVoxel) {
        totalSS += nodes[i].screenSize * nodes[i].count;
        leafPointCount += nodes[i].count;
      }
    }

    if (leafPointCount === 0) {
      this.density = 1.0;
      return;
    }

    const avgSS = totalSS / leafPointCount;
    const budgetRatio = this.pointBudget / this.visiblePointCount;

    for (let i = 0; i < n; i++) {
      const node = nodes[i];

      // Don't thin voxels — they're already coarse LOD representations
      if (node.isVoxel) continue;

      // Tiny nodes always render at full density (< 1000 points = negligible cost)
      if (node.count < 1000) continue;

      // Proportional density: nodes with larger screen size keep more points
      const ssWeight = avgSS > 0 ? node.screenSize / avgSS : 1;
      const rawDensity = budgetRatio * Math.sqrt(ssWeight);
      node.density = Math.max(MIN_DENSITY, Math.min(1.0, rawDensity)) * node.fadeAlpha;
    }

    this.density = Math.max(MIN_DENSITY, budgetRatio);
  }

  // ── Temporal density smoothing ──

  private applyTemporalSmoothing(): void {
    const nodes = this.visibleNodes;
    const n = nodes.length;
    const swap = this.prevDensitySwap;
    swap.clear();

    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      const key = node.offset; // unique per node in flattened buffer
      const prev = this.prevDensity.get(key);

      if (prev !== undefined) {
        // Lerp towards target density for smooth transitions
        const target = node.density;
        node.density = prev + (target - prev) * DENSITY_BLEND_RATE;
      }

      swap.set(key, node.density);
    }

    // Swap maps (avoid allocations)
    const tmp = this.prevDensity;
    this.prevDensity = swap;
    this.prevDensitySwap = tmp;
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
      if (this.slowFrameCount >= 4) {
        this.pointBudget = Math.max(MIN_POINT_BUDGET, Math.floor(this.pointBudget * 0.90));
        this.slowFrameCount = 0;
      }
    } else if (avgMs < TARGET_FRAME_MS * 0.80) {
      this.fastFrameCount++;
      this.slowFrameCount = 0;
      if (this.fastFrameCount >= 4) {
        this.pointBudget = Math.min(MAX_POINT_BUDGET, Math.floor(this.pointBudget * 1.20));
        this.fastFrameCount = 0;
      }
    } else {
      this.slowFrameCount = 0;
      this.fastFrameCount = 0;
    }
  }
}
