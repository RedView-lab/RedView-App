// ============================================
// Octree LOD — Manager
// Smooth cross-fading, proportional budget,
// temporal density smoothing, GPU stochastic discard.
// ============================================

import type { SerializedNode, VisibleNode, CameraState, FlatOctree, PlatformProfile } from './types';
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

const QUALITY_TIER_SCALES = [1.0, 0.72, 0.48, 0.28] as const;
const IDLE_DENSITY_BUCKETS = 20;
const ACTIVE_DENSITY_BUCKETS = 12;
const STRESSED_DENSITY_BUCKETS = 8;

export class LodManager {
  private octree: FlatOctree | null = null;
  private visibleNodes: VisibleNode[] = [];
  private visiblePointCount = 0;

  density = 1.0;
  private userDensityScale = 1.0;
  private sceneBudgetScale = 1.0;

  private refinedLastFrame = new Set<number>();
  private refinedThisFrame = new Set<number>();
  private refinedSpare = new Set<number>();

  private lastCamera: CameraState | null = null;
  private cacheValid = false;

  private pointBudget = INITIAL_POINT_BUDGET;
  private minBudget = MIN_POINT_BUDGET;
  private maxBudget = MAX_POINT_BUDGET;
  /** Per-platform target frame time (16.6ms desktop, 33.3ms Apple/integrated). */
  private targetFrameMs = TARGET_FRAME_MS;
  /**
   * Scales LOD fade thresholds (see PlatformProfile.lodScreenScale).
   * Higher = nodes drop to voxels earlier (better perf, less detail far away).
   */
  private lodScreenScale = 1.0;
  /**
   * Pixels of screen-space size below which a node is skipped entirely.
   * Even a single voxel batch costs draw call + ~64 fragments minimum,
   * so dropping invisible-to-the-eye nodes is a clear win.
   */
  private minScreenSizePx = 2.0;
  /**
   * If true, sort visible nodes near→far each frame so TBDR HSR can reject
   * overdrawn fragments. Worth it on Apple Silicon, neutral-to-negative on
   * dGPUs where it would also break contiguous-offset draw batching.
   */
  private sortFrontToBack = false;
  /** EWMA-smoothed frame time — more stable than sliding window mean. */
  private avgFrameMs = TARGET_FRAME_MS;
  private framesSeen = 0;
  private slowFrameCount = 0;
  private fastFrameCount = 0;
  private motionPressure = 0;
  private framePressure = 1;

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
    qualityScale: 1,
    motionPressure: 0,
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

  /** Apply platform-specific budget limits (e.g. lower for Apple M1 unified memory). */
  applyPlatformProfile(profile: PlatformProfile) {
    this.pointBudget = profile.initialBudget;
    this.minBudget = Math.min(profile.initialBudget, MIN_POINT_BUDGET);
    this.maxBudget = profile.maxBudget;
    this.targetFrameMs = profile.targetFrameMs;
    this.avgFrameMs = profile.targetFrameMs;
    this.lodScreenScale = profile.lodScreenScale;
    // Apple TBDR: skip slightly larger nodes since each pixel of overdraw is
    // costly; on dGPUs we can afford to render down to the pixel.
    this.minScreenSizePx = profile.isApple ? 3.0 : 2.0;
    // Front-to-back sort only helps TBDR architectures (Apple). On
    // immediate-mode dGPUs it just costs CPU and breaks draw batching.
    this.sortFrontToBack = profile.isApple;
    this.stats.pointBudget = this.getEffectivePointBudget();
    console.log(
      `[LOD] Platform budget: ${(this.pointBudget / 1e6).toFixed(1)}M ` +
      `(max ${(this.maxBudget / 1e6).toFixed(1)}M) target ${this.targetFrameMs.toFixed(1)}ms ` +
      `lodScale ${this.lodScreenScale.toFixed(2)}× minPx ${this.minScreenSizePx}`,
    );
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

    this.updateMotionPressure(camPosX, camPosY, camPosZ, camFwdX, camFwdY, camFwdZ);
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

    this.collectVisible(this.octree.root, planes, viewProj, viewportW, viewportH, true, camPosX, camPosY, camPosZ);

    this.enforceBudget();
    this.applyTemporalSmoothing();

    // Front-to-back sort — critical for Apple TBDR Hidden Surface Removal:
    // when the GPU draws the nearest points first, subsequent overdrawn
    // fragments are rejected before fragment shader execution.
    // Trade-off: breaks the contiguous-offset batching in renderer.ts so we
    // get 1 draw call per visible node (more CPU work) — but on Apple HSR
    // dwarfs that cost. On desktop dGPUs we keep the original octree order
    // which preserves perfect batching.
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

  // ── LOD collection with smooth cross-fade zone ──

  private collectVisible(
    node: SerializedNode,
    planes: FrustumPlanes,
    viewProj: Float32Array,
    vpW: number,
    vpH: number,
    testFrustum: boolean,
    camX: number = 0,
    camY: number = 0,
    camZ: number = 0,
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

    // Micro-node skip: nodes that project to < minScreenSizePx contribute
    // nothing visually but still cost a draw call + per-vertex shading.
    // Drop them entirely (their parent's voxels already cover the area).
    if (ss < this.minScreenSizePx) {
      this.stats.lodSkipped++;
      return;
    }

    // Squared distance from camera to AABB center — used for the
    // front-to-back sort that drives Apple TBDR HSR.
    const acx = (node.aabb.minX + node.aabb.maxX) * 0.5;
    const acy = (node.aabb.minY + node.aabb.maxY) * 0.5;
    const acz = (node.aabb.minZ + node.aabb.maxZ) * 0.5;
    const dxC = acx - camX, dyC = acy - camY, dzC = acz - camZ;
    const camDist2 = dxC * dxC + dyC * dyC + dzC * dzC;

    // Hysteresis: refined nodes use lower threshold to avoid oscillation
    // lodScreenScale (>1 on Apple) inflates the threshold so nodes drop to
    // voxels at a larger projected size \u2014 fewer leaves rendered far away.
    let fadeLow = LOD_FADE_LOW * this.lodScreenScale;
    let fadeHigh = LOD_FADE_HIGH * this.lodScreenScale;
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
          qualityTier: 0,
          qualityScale: 1.0,
          fadeAlpha: 1.0,
          camDist2,
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
          qualityTier: 0,
          qualityScale: 1.0,
          fadeAlpha: 1.0,
          camDist2,
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
          qualityTier: 0,
          qualityScale: 1.0,
          fadeAlpha: voxelAlpha,
          camDist2,
        });
        this.visiblePointCount += Math.ceil(node.voxelCount * voxelAlpha);
        if (node.depth < this.voxelMinDepth) this.voxelMinDepth = node.depth;
      }

      // Emit fading-in children
      this.refinedThisFrame.add(node.id);
      const pointsBefore = this.visiblePointCount;

      for (let i = 0; i < 8; i++) {
        const child = node.children[i];
        if (child) this.collectVisible(child, planes, viewProj, vpW, vpH, testFrustum, camX, camY, camZ);
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
          qualityTier: 0,
          qualityScale: 1.0,
          fadeAlpha: 1.0,
          camDist2,
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
        this.collectVisible(child, planes, viewProj, vpW, vpH, testFrustum, camX, camY, camZ);
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
        qualityTier: 0,
        qualityScale: 1.0,
        fadeAlpha: 1.0,
        camDist2,
      });
      this.visiblePointCount += node.voxelCount;
      if (node.depth < this.voxelMinDepth) this.voxelMinDepth = node.depth;
    }
  }

  // ── Proportional budget enforcement ──

  private enforceBudget(): void {
    const nodes = this.visibleNodes;
    const n = nodes.length;
    const effectiveBudget = this.getEffectivePointBudget();
    const qualityAdjustedPointCount = this.applyQualityTiers(effectiveBudget);

    if (qualityAdjustedPointCount <= effectiveBudget) {
      this.density = 1.0;
      this.visiblePointCount = qualityAdjustedPointCount;
      return;
    }

    // Compute average screen size for proportional weighting
    let totalSS = 0;
    let leafPointCount = 0;
    for (let i = 0; i < n; i++) {
      if (!nodes[i].isVoxel) {
        const weightedCount = Math.max(1, Math.ceil(nodes[i].count * nodes[i].qualityScale));
        totalSS += nodes[i].screenSize * weightedCount;
        leafPointCount += weightedCount;
      }
    }

    if (leafPointCount === 0) {
      this.density = 1.0;
      return;
    }

    const avgSS = totalSS / leafPointCount;
    const budgetRatio = effectiveBudget / qualityAdjustedPointCount;

    for (let i = 0; i < n; i++) {
      const node = nodes[i];

      // Don't thin voxels — they're already coarse LOD representations
      if (node.isVoxel) continue;

      // Tiny nodes always render at full density (< 1000 points = negligible cost)
      if (node.count < 1000) {
        node.density = Math.max(MIN_DENSITY, node.qualityScale * node.fadeAlpha);
        continue;
      }

      // Proportional density: nodes with larger screen size keep more points
      const ssWeight = avgSS > 0 ? node.screenSize / avgSS : 1;
      const rawDensity = budgetRatio * Math.sqrt(ssWeight);
      const qualityBudgetScale = node.qualityScale * Math.max(MIN_DENSITY, Math.min(1.0, rawDensity));
      node.density = Math.max(MIN_DENSITY, qualityBudgetScale * node.fadeAlpha);
    }

    this.visiblePointCount = this.estimateVisiblePointCount();
    this.density = Math.max(MIN_DENSITY, Math.min(1.0, budgetRatio));
    this.stats.qualityScale = this.estimateLeafQualityScale();
    this.stats.motionPressure = this.motionPressure;
  }

  private getEffectivePointBudget(): number {
    return Math.max(1, Math.floor(this.pointBudget * this.userDensityScale * this.sceneBudgetScale));
  }

  private quantizeLeafDensity(density: number): number {
    const clamped = Math.max(MIN_DENSITY, Math.min(1.0, density));
    if (clamped >= 0.995) return 1.0;

    const bucketCount = this.framePressure > 1.16 || this.motionPressure > 0.55
      ? STRESSED_DENSITY_BUCKETS
      : this.framePressure > 1.04 || this.motionPressure > 0.18
        ? ACTIVE_DENSITY_BUCKETS
        : IDLE_DENSITY_BUCKETS;

    return Math.max(MIN_DENSITY, Math.round(clamped * bucketCount) / bucketCount);
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

      if (!node.isVoxel) {
        node.density = this.quantizeLeafDensity(node.density);
      }

      swap.set(key, node.density);
    }

    // Swap maps (avoid allocations)
    const tmp = this.prevDensity;
    this.prevDensity = swap;
    this.prevDensitySwap = tmp;
    this.visiblePointCount = this.estimateVisiblePointCount();
    this.stats.qualityScale = this.estimateLeafQualityScale();
    this.stats.motionPressure = this.motionPressure;
  }

  private applyQualityTiers(effectiveBudget: number): number {
    const nodes = this.visibleNodes;
    const budgetPressure = this.visiblePointCount / Math.max(effectiveBudget, 1);
    let total = 0;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.isVoxel) {
        node.qualityTier = 0;
        node.qualityScale = 1.0;
        node.density = node.fadeAlpha;
        total += Math.max(1, Math.ceil(node.count * node.density));
        continue;
      }

      const qualityTier = this.selectQualityTier(node.screenSize, budgetPressure);
      node.qualityTier = qualityTier;
      node.qualityScale = QUALITY_TIER_SCALES[qualityTier];
      node.density = Math.max(MIN_DENSITY, node.qualityScale * node.fadeAlpha);
      total += Math.max(1, Math.ceil(node.count * node.density));
    }

    this.visiblePointCount = total;
    this.stats.qualityScale = this.estimateLeafQualityScale();
    this.stats.motionPressure = this.motionPressure;
    return total;
  }

  private selectQualityTier(screenSize: number, budgetPressure: number): number {
    let tier = 0;
    if (screenSize < 95) tier = 2;
    else if (screenSize < 150) tier = 1;

    if (screenSize < 72) tier += 1;
    if (this.motionPressure > 0.18) tier += 1;
    if (this.motionPressure > 0.55) tier += 1;
    if (this.framePressure > 1.04) tier += 1;
    if (this.framePressure > 1.18) tier += 1;
    if (budgetPressure > 1.08) tier += 1;
    if (budgetPressure > 1.32) tier += 1;
    if (screenSize > 220) tier -= 1;
    if (screenSize > 320) tier -= 1;

    return Math.max(0, Math.min(QUALITY_TIER_SCALES.length - 1, tier));
  }

  private estimateVisiblePointCount(): number {
    let total = 0;
    for (let i = 0; i < this.visibleNodes.length; i++) {
      const node = this.visibleNodes[i];
      total += Math.max(1, Math.ceil(node.count * node.density));
    }
    return total;
  }

  private estimateLeafQualityScale(): number {
    let weightedQuality = 0;
    let weightedPoints = 0;
    for (let i = 0; i < this.visibleNodes.length; i++) {
      const node = this.visibleNodes[i];
      if (node.isVoxel || node.count === 0) continue;
      weightedQuality += node.qualityScale * node.count;
      weightedPoints += node.count;
    }
    return weightedPoints > 0 ? weightedQuality / weightedPoints : 1;
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

  private updateMotionPressure(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
  ): void {
    if (!this.lastCamera) {
      this.motionPressure *= 0.85;
      return;
    }

    const lc = this.lastCamera;
    const dx = px - lc.posX;
    const dy = py - lc.posY;
    const dz = pz - lc.posZ;
    const posDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const posPressure = Math.min(1, posDist / (TEMPORAL_POS_THRESHOLD * 5));

    const dot = fx * lc.fwdX + fy * lc.fwdY + fz * lc.fwdZ;
    const angle = Math.acos(Math.min(1, Math.max(-1, dot))) * (180 / Math.PI);
    const rotPressure = Math.min(1, angle / (TEMPORAL_ROT_THRESHOLD * 7));

    const targetPressure = Math.max(posPressure, rotPressure);
    this.motionPressure += (targetPressure - this.motionPressure) * 0.25;
  }

  private updateBudget(deltaMs: number): void {
    // Clamp pathological values (tab switch, GC pause) so they don't poison
    // the EWMA and trigger spurious budget cuts on the next frame.
    const sample = Math.max(1, Math.min(deltaMs, this.targetFrameMs * 4));

    // EWMA: gives recent frames more weight than a sliding window mean,
    // and updates every frame instead of only when the window is full.
    // alpha = 1/8 → ~half-life of ~5 frames.
    const alpha = 1 / 8;
    this.avgFrameMs = this.avgFrameMs * (1 - alpha) + sample * alpha;
    this.framesSeen++;

    if (this.framesSeen < FRAME_WINDOW) return; // warm-up

    const avgMs = this.avgFrameMs;
    this.stats.fps = Math.round(1000 / avgMs);
    this.framePressure = avgMs / Math.max(this.targetFrameMs, 1);

    const target = this.targetFrameMs;
    if (avgMs > target * 1.15) {
      this.slowFrameCount++;
      this.fastFrameCount = 0;
      if (this.slowFrameCount >= 4) {
        this.pointBudget = Math.max(this.minBudget, Math.floor(this.pointBudget * 0.90));
        this.slowFrameCount = 0;
      }
    } else if (avgMs < target * 0.80) {
      this.fastFrameCount++;
      this.slowFrameCount = 0;
      if (this.fastFrameCount >= 4) {
        this.pointBudget = Math.min(this.maxBudget, Math.floor(this.pointBudget * 1.20));
        this.fastFrameCount = 0;
      }
    } else {
      this.slowFrameCount = 0;
      this.fastFrameCount = 0;
    }
  }
}
