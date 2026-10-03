// ============================================
// LiDAR LOD — Shared types
// ============================================

/** Coarse GPU class, from adapter info (see `resolvePlatformInfo`). */
export type GpuTier = 'integrated' | 'discrete' | 'apple';

/** Platform-dependent GPU/memory profile */
export interface PlatformProfile {
  tier: GpuTier;
  /** Floor of the adaptive budget (emergency cuts never go below). */
  minBudget: number;
  initialBudget: number;
  /** Ceiling of the moving-camera budget. */
  maxBudget: number;
  /** Ceiling of the still-camera budget (see RestRefinement). */
  restMaxBudget: number;
  /** Points kept resident on the GPU (≥ restMaxBudget; the rest is evicted LRU). */
  poolBudget: number;
  maxCanvasDim: number;
  dprCap: number;
  isApple: boolean;
  /** Scene resolution while the camera moves, as a share of the canvas (fill-rate saving). */
  motionScale: number;
}

/** Axis-aligned bounding box */
export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}
