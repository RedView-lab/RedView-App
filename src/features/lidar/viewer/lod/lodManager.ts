// ============================================
// Octree LOD — Manager
// Smooth cross-fading, proportional budget,
// temporal density smoothing, GPU stochastic discard.
// ============================================

import type { VisibleNode, CameraState, FlatOctree, PlatformProfile } from './types';
import {
  LOD_FADE_LOW,
  LOD_FADE_HIGH,
  TEMPORAL_POS_THRESHOLD,
  TEMPORAL_ROT_THRESHOLD,
  INITIAL_POINT_BUDGET,
  MIN_POINT_BUDGET,
  MAX_POINT_BUDGET,
  TARGET_FRAME_MS,
  OCCUPANCY_GRID_SIZE,
  MIN_DENSITY,
} from './types';
import {
  extractFrustumPlanes,
} from './frustum';
import {
  computeDynamicLodScale,
  computeDynamicMinScreenSizePx,
  computeEffectivePointBudget,
  updateAdaptiveBudget,
  updateMotionPressureValue,
} from './lodBudget';
import {
  applyTemporalSmoothingToNodes,
  enforceLodBudget,
} from './lodBudgetEnforcer';
import {
  collectVisibleOctreeNode,
  type LodCollectContext,
} from './lodCollector';

export class LodManager {
  private octree: FlatOctree | null = null;
  private visibleNodes: VisibleNode[] = [];
  private visiblePointCount = 0;

  /** Pool of VisibleNode objects, reused across frames to avoid GC pressure. */
  private _nodePool: VisibleNode[] = [];
  private _nodePoolCursor = 0;

  density = 1.0;
  private userDensityScale = 1.0;
  private sceneBudgetScale = 1.0;

  private refinedLastFrame: Uint8Array = new Uint8Array(0);
  private refinedThisFrame: Uint8Array = new Uint8Array(0);

  private lastCamera: CameraState | null = null;
  private cacheValid = false;

  private pointBudget = INITIAL_POINT_BUDGET;
  private minBudget = MIN_POINT_BUDGET;
  private maxBudget = MAX_POINT_BUDGET;
  private targetFrameMs = TARGET_FRAME_MS;
  private lodScreenScale = 1.0;
  private minScreenSizePx = 2.0;
  private sortFrontToBack = false;
  private avgFrameMs = TARGET_FRAME_MS;
  private framesSeen = 0;
  private slowFrameCount = 0;
  private fastFrameCount = 0;
  private motionPressure = 0;
  private framePressure = 1;

  private prevDensity: Float32Array = new Float32Array(0);
  private prevDensityValid: Uint8Array = new Uint8Array(0);
  private prevDensityValidSwap: Uint8Array = new Uint8Array(0);
  private prevDensitySwap: Float32Array = new Float32Array(0);

  private cachedMinScreenPx = 2.0;
  private cachedFadeLowBase = LOD_FADE_LOW;
  private cachedFadeHighBase = LOD_FADE_HIGH;

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
    qualityScale: 1,
    motionPressure: 0,
  };

  setOctree(octree: FlatOctree) {
    this.octree = octree;
    this.refinedLastFrame = new Uint8Array(octree.nodeCount);
    this.refinedThisFrame = new Uint8Array(octree.nodeCount);
    this.prevDensity = new Float32Array(octree.nodeCount);
    this.prevDensitySwap = new Float32Array(octree.nodeCount);
    this.prevDensityValid = new Uint8Array(octree.nodeCount);
    this.prevDensityValidSwap = new Uint8Array(octree.nodeCount);
    this.lastCamera = null;
    this.cacheValid = false;
    this.stats.totalPoints = octree.totalLeafPoints;
    this.stats.totalNodes = octree.nodeCount;
    this.stats.maxDepth = octree.maxDepthReached;
    this.stats.voxelSamples = octree.totalVoxelSamples;

    const r = octree.root.aabb;
    this.rootExtent = Math.max(r.maxX - r.minX, r.maxY - r.minY, r.maxZ - r.minZ);
  }

  applyPlatformProfile(profile: PlatformProfile) {
    this.pointBudget = profile.initialBudget;
    this.minBudget = Math.min(profile.initialBudget, MIN_POINT_BUDGET);
    this.maxBudget = profile.maxBudget;
    this.targetFrameMs = profile.targetFrameMs;
    this.avgFrameMs = profile.targetFrameMs;
    this.lodScreenScale = profile.lodScreenScale;
    this.minScreenSizePx = profile.isApple ? 3.0 : 2.0;
    this.sortFrontToBack = profile.isApple;
    this.stats.pointBudget = this.getEffectivePointBudget();
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
    return this.getEffectivePointBudget();
  }

  getUserDensityScale(): number {
    return this.userDensityScale;
  }

  setUserDensityScale(scale: number): void {
    this.userDensityScale = Math.max(MIN_DENSITY, Math.min(1.0, scale));
    this.stats.pointBudget = this.getEffectivePointBudget();
  }

  setSceneBudgetScale(scale: number): void {
    this.sceneBudgetScale = Math.max(0.35, Math.min(1.0, scale));
    this.stats.pointBudget = this.getEffectivePointBudget();
  }

  update(
    viewProj: Float32Array,
    camPosX: number, camPosY: number, camPosZ: number,
    camFwdX: number, camFwdY: number, camFwdZ: number,
    viewportW: number, viewportH: number,
    deltaMs: number,
  ): void {
    if (!this.octree) return;

    this.motionPressure = updateMotionPressureValue(
      this.motionPressure,
      this.lastCamera,
      camPosX, camPosY, camPosZ,
      camFwdX, camFwdY, camFwdZ,
    );

    const budgetUpdate = updateAdaptiveBudget({
      pointBudget: this.pointBudget,
      minBudget: this.minBudget,
      maxBudget: this.maxBudget,
      targetFrameMs: this.targetFrameMs,
      avgFrameMs: this.avgFrameMs,
      framesSeen: this.framesSeen,
      slowFrameCount: this.slowFrameCount,
      fastFrameCount: this.fastFrameCount,
      motionPressure: this.motionPressure,
      framePressure: this.framePressure,
      userDensityScale: this.userDensityScale,
      sceneBudgetScale: this.sceneBudgetScale,
      minScreenSizePx: this.minScreenSizePx,
    }, deltaMs);

    this.pointBudget = budgetUpdate.pointBudget;
    this.avgFrameMs = budgetUpdate.avgFrameMs;
    this.framesSeen = budgetUpdate.framesSeen;
    this.slowFrameCount = budgetUpdate.slowFrameCount;
    this.fastFrameCount = budgetUpdate.fastFrameCount;
    this.stats.fps = budgetUpdate.fps;
    this.framePressure = budgetUpdate.framePressure;

    if (this.checkTemporalCoherence(camPosX, camPosY, camPosZ, camFwdX, camFwdY, camFwdZ)) {
      this.enforceBudget();
      this.applyTemporalSmoothing();
      return;
    }

    const planes = extractFrustumPlanes(viewProj);

    const tmpRef = this.refinedLastFrame;
    this.refinedLastFrame = this.refinedThisFrame;
    this.refinedThisFrame = tmpRef;
    this.refinedThisFrame.fill(0);

    const dynLodScale = computeDynamicLodScale(this.sceneBudgetScale, this.motionPressure, this.framePressure);
    this.cachedMinScreenPx = computeDynamicMinScreenSizePx(this.minScreenSizePx, this.sceneBudgetScale, this.motionPressure, this.framePressure);
    this.cachedFadeLowBase = LOD_FADE_LOW * this.lodScreenScale * dynLodScale;
    this.cachedFadeHighBase = LOD_FADE_HIGH * this.lodScreenScale * dynLodScale;

    this.visibleNodes.length = 0;
    this._nodePoolCursor = 0;
    this.visiblePointCount = 0;
    this.voxelMinDepth = this.octree.maxDepthReached;
    this.stats.frustumCulled = 0;
    this.stats.lodSkipped = 0;

    const ctx: LodCollectContext = {
      planes,
      viewProj,
      vpW: viewportW,
      vpH: viewportH,
      camX: camPosX,
      camY: camPosY,
      camZ: camPosZ,
      cachedMinScreenPx: this.cachedMinScreenPx,
      cachedFadeLowBase: this.cachedFadeLowBase,
      cachedFadeHighBase: this.cachedFadeHighBase,
      refinedLastFrame: this.refinedLastFrame,
      refinedThisFrame: this.refinedThisFrame,
      acquireNode: () => this.acquireNode(),
      visibleNodes: this.visibleNodes,
      visiblePointCount: this.visiblePointCount,
      voxelMinDepth: this.voxelMinDepth,
      frustumCulled: this.stats.frustumCulled,
      lodSkipped: this.stats.lodSkipped,
    };

    collectVisibleOctreeNode(this.octree.root, ctx, true);

    this.visiblePointCount = ctx.visiblePointCount;
    this.voxelMinDepth = ctx.voxelMinDepth;
    this.stats.frustumCulled = ctx.frustumCulled;
    this.stats.lodSkipped = ctx.lodSkipped;

    this.enforceBudget();
    this.applyTemporalSmoothing();

    if (this.sortFrontToBack) {
      this.visibleNodes.sort((a, b) => {
        if (a.isVoxel !== b.isVoxel) return a.isVoxel ? -1 : 1;
        return a.camDist2 - b.camDist2;
      });
    }

    this.stats.visiblePoints = this.visiblePointCount;
    this.stats.visibleNodes = this.visibleNodes.length;
    this.stats.pointBudget = this.getEffectivePointBudget();

    if (!this.lastCamera) {
      this.lastCamera = { posX: camPosX, posY: camPosY, posZ: camPosZ, fwdX: camFwdX, fwdY: camFwdY, fwdZ: camFwdZ };
    } else {
      this.lastCamera.posX = camPosX; this.lastCamera.posY = camPosY; this.lastCamera.posZ = camPosZ;
      this.lastCamera.fwdX = camFwdX; this.lastCamera.fwdY = camFwdY; this.lastCamera.fwdZ = camFwdZ;
    }
    this.cacheValid = true;
  }

  private acquireNode(): VisibleNode {
    let node = this._nodePool[this._nodePoolCursor];
    if (!node) {
      node = {
        nodeId: 0,
        offset: 0,
        count: 0,
        isVoxel: false,
        depth: 0,
        screenSize: 0,
        density: 1.0,
        qualityTier: 0,
        qualityScale: 1.0,
        fadeAlpha: 1.0,
        camDist2: 0,
      };
      this._nodePool[this._nodePoolCursor] = node;
    }
    this._nodePoolCursor++;
    return node;
  }

  private enforceBudget(): void {
    const res = enforceLodBudget(
      this.visibleNodes,
      this.getEffectivePointBudget(),
      this.visiblePointCount,
      this.motionPressure,
      this.framePressure,
    );
    this.density = res.density;
    this.visiblePointCount = res.visiblePointCount;
    this.stats.qualityScale = res.qualityScale;
    this.stats.motionPressure = this.motionPressure;
  }

  private getEffectivePointBudget(): number {
    return computeEffectivePointBudget(this.pointBudget, this.userDensityScale, this.sceneBudgetScale);
  }

  private applyTemporalSmoothing(): void {
    const res = applyTemporalSmoothingToNodes(
      this.visibleNodes,
      this.prevDensity,
      this.prevDensityValid,
      this.prevDensitySwap,
      this.prevDensityValidSwap,
      this.motionPressure,
      this.framePressure,
    );

    const tmpD = this.prevDensity;
    this.prevDensity = this.prevDensitySwap;
    this.prevDensitySwap = tmpD;

    const tmpV = this.prevDensityValid;
    this.prevDensityValid = this.prevDensityValidSwap;
    this.prevDensityValidSwap = tmpV;

    this.visiblePointCount = res.visiblePointCount;
    this.stats.qualityScale = res.qualityScale;
    this.stats.motionPressure = this.motionPressure;
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
}
