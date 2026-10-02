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
  maxBudget: number;
  /** Points kept resident on the GPU (≥ maxBudget; the rest is evicted LRU). */
  poolBudget: number;
  maxCanvasDim: number;
  dprCap: number;
  isApple: boolean;
  /** Target frame time in ms used by adaptive budget (lower = aim for higher FPS). */
  targetFrameMs: number;
}

/** Axis-aligned bounding box */
export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}
