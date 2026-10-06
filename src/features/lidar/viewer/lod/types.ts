// ============================================
// LiDAR LOD — Shared types
// ============================================

/**
 * Coarse GPU class, from adapter info (see `resolvePlatformInfo`) or the
 * WebGL renderer string (`resolveWebglPlatformInfo`). `software`: CPU
 * rasteriser (llvmpipe, SwiftShader, WARP) — only the WebGL 2 backend runs
 * on one, WebGPU refuses software adapters.
 */
export type GpuTier = 'integrated' | 'discrete' | 'apple' | 'software';

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
