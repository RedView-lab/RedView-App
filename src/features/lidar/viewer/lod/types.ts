// ============================================
// LOD LiDAR — types partagés
// ============================================

/**
 * Classe de GPU grossière, d'après les infos de l'adaptateur (voir
 * `resolvePlatformInfo`) ou la chaîne du renderer WebGL (`resolveWebglPlatformInfo`).
 * `software` : rastériseur CPU (llvmpipe, SwiftShader, WARP) — seul le backend
 * WebGL 2 y tourne, WebGPU refuse les adaptateurs logiciels.
 */
export type GpuTier = 'integrated' | 'discrete' | 'apple' | 'software';

/** Profil GPU/mémoire dépendant de la plateforme */
export interface PlatformProfile {
  tier: GpuTier;
  /** Plancher du budget adaptatif (les coupes d'urgence ne descendent jamais en dessous). */
  minBudget: number;
  initialBudget: number;
  /** Plafond du budget caméra en mouvement. */
  maxBudget: number;
  /** Plafond du budget caméra fixe (voir RestRefinement). */
  restMaxBudget: number;
  /** Points gardés résidents sur le GPU (≥ restMaxBudget ; le reste est évincé en LRU). */
  poolBudget: number;
  maxCanvasDim: number;
  dprCap: number;
  isApple: boolean;
  /** Résolution de la scène pendant que la caméra bouge, en part du canvas (économie de fill-rate). */
  motionScale: number;
}

/** Boîte englobante alignée sur les axes */
export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}
