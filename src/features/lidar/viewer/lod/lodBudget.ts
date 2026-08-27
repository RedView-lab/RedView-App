import {
  FRAME_WINDOW,
  MIN_DENSITY,
  TEMPORAL_POS_THRESHOLD,
  TEMPORAL_ROT_THRESHOLD,
} from './types';

export const QUALITY_TIER_SCALES = [1.0, 0.72, 0.48, 0.28] as const;
export const IDLE_DENSITY_BUCKETS = 20;
export const ACTIVE_DENSITY_BUCKETS = 12;
export const STRESSED_DENSITY_BUCKETS = 8;

export interface LodBudgetState {
  pointBudget: number;
  minBudget: number;
  maxBudget: number;
  targetFrameMs: number;
  avgFrameMs: number;
  framesSeen: number;
  slowFrameCount: number;
  fastFrameCount: number;
  motionPressure: number;
  framePressure: number;
  userDensityScale: number;
  sceneBudgetScale: number;
  minScreenSizePx: number;
}

export function computeEffectivePointBudget(
  pointBudget: number,
  userDensityScale: number,
  sceneBudgetScale: number,
): number {
  return Math.max(1, Math.floor(pointBudget * userDensityScale * sceneBudgetScale));
}

export function computeDynamicLodScale(
  sceneBudgetScale: number,
  motionPressure: number,
  framePressure: number,
): number {
  const multiTilePressure = 1 + (1 - sceneBudgetScale) * 1.15;
  const motionPressureScale = 1 + motionPressure * 0.55;
  const framePressureScale = 1 + Math.max(0, framePressure - 1) * 0.75;
  return Math.min(2.4, multiTilePressure * motionPressureScale * framePressureScale);
}

export function computeDynamicMinScreenSizePx(
  minScreenSizePx: number,
  sceneBudgetScale: number,
  motionPressure: number,
  framePressure: number,
): number {
  const scenePressure = 1 + (1 - sceneBudgetScale) * 0.9;
  const motionPressureScale = 1 + motionPressure * 0.35;
  const framePressureScale = 1 + Math.max(0, framePressure - 1) * 0.45;
  return Math.min(7.5, minScreenSizePx * scenePressure * motionPressureScale * framePressureScale);
}

export function quantizeLeafDensityValue(
  density: number,
  framePressure: number,
  motionPressure: number,
): number {
  const clamped = Math.max(MIN_DENSITY, Math.min(1.0, density));
  if (clamped >= 0.995) return 1.0;

  const bucketCount = framePressure > 1.16 || motionPressure > 0.55
    ? STRESSED_DENSITY_BUCKETS
    : framePressure > 1.04 || motionPressure > 0.18
      ? ACTIVE_DENSITY_BUCKETS
      : IDLE_DENSITY_BUCKETS;

  return Math.max(MIN_DENSITY, Math.round(clamped * bucketCount) / bucketCount);
}

export function selectLodQualityTier(
  screenSize: number,
  budgetPressure: number,
  motionPressure: number,
  framePressure: number,
): number {
  let tier = 0;
  if (screenSize < 55) tier = 2;
  else if (screenSize < 110) tier = 1;

  if (screenSize < 40) tier += 1;
  if (motionPressure > 0.18) tier += 1;
  if (motionPressure > 0.55) tier += 1;
  if (framePressure > 1.04) tier += 1;
  if (framePressure > 1.18) tier += 1;
  if (budgetPressure > 1.08) tier += 1;
  if (budgetPressure > 1.32) tier += 1;
  if (screenSize > 220) tier -= 1;
  if (screenSize > 320) tier -= 1;

  return Math.max(0, Math.min(QUALITY_TIER_SCALES.length - 1, tier));
}

export function updateMotionPressureValue(
  currentMotionPressure: number,
  lastCamera: { posX: number; posY: number; posZ: number; fwdX: number; fwdY: number; fwdZ: number } | null,
  px: number, py: number, pz: number,
  fx: number, fy: number, fz: number,
): number {
  if (!lastCamera) {
    return currentMotionPressure * 0.85;
  }

  const dx = px - lastCamera.posX;
  const dy = py - lastCamera.posY;
  const dz = pz - lastCamera.posZ;
  const posDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const posPressure = Math.min(1, posDist / (TEMPORAL_POS_THRESHOLD * 5));

  const dot = fx * lastCamera.fwdX + fy * lastCamera.fwdY + fz * lastCamera.fwdZ;
  const angle = Math.acos(Math.min(1, Math.max(-1, dot))) * (180 / Math.PI);
  const rotPressure = Math.min(1, angle / (TEMPORAL_ROT_THRESHOLD * 7));

  const targetPressure = Math.max(posPressure, rotPressure);
  return currentMotionPressure + (targetPressure - currentMotionPressure) * 0.25;
}

export function updateAdaptiveBudget(
  budgetState: LodBudgetState,
  deltaMs: number,
): { pointBudget: number; avgFrameMs: number; framesSeen: number; slowFrameCount: number; fastFrameCount: number; fps: number; framePressure: number } {
  const sample = Math.max(1, Math.min(deltaMs, budgetState.targetFrameMs * 4));
  const alpha = 1 / 8;
  const nextAvgFrameMs = budgetState.avgFrameMs * (1 - alpha) + sample * alpha;
  const nextFramesSeen = budgetState.framesSeen + 1;

  if (nextFramesSeen < FRAME_WINDOW) {
    return {
      pointBudget: budgetState.pointBudget,
      avgFrameMs: nextAvgFrameMs,
      framesSeen: nextFramesSeen,
      slowFrameCount: budgetState.slowFrameCount,
      fastFrameCount: budgetState.fastFrameCount,
      fps: Math.round(1000 / Math.max(nextAvgFrameMs, 1)),
      framePressure: nextAvgFrameMs / Math.max(budgetState.targetFrameMs, 1),
    };
  }

  const fps = Math.round(1000 / nextAvgFrameMs);
  const framePressure = nextAvgFrameMs / Math.max(budgetState.targetFrameMs, 1);
  const target = budgetState.targetFrameMs;

  let pointBudget = budgetState.pointBudget;
  let slowFrameCount = budgetState.slowFrameCount;
  let fastFrameCount = budgetState.fastFrameCount;

  if (nextAvgFrameMs > target * 1.15) {
    slowFrameCount++;
    fastFrameCount = 0;
    if (slowFrameCount >= 4) {
      pointBudget = Math.max(budgetState.minBudget, Math.floor(pointBudget * 0.90));
      slowFrameCount = 0;
    }
  } else if (nextAvgFrameMs < target * 0.80) {
    fastFrameCount++;
    slowFrameCount = 0;
    if (fastFrameCount >= 4) {
      pointBudget = Math.min(budgetState.maxBudget, Math.floor(pointBudget * 1.20));
      fastFrameCount = 0;
    }
  } else {
    slowFrameCount = 0;
    fastFrameCount = 0;
  }

  return {
    pointBudget,
    avgFrameMs: nextAvgFrameMs,
    framesSeen: nextFramesSeen,
    slowFrameCount,
    fastFrameCount,
    fps,
    framePressure,
  };
}
