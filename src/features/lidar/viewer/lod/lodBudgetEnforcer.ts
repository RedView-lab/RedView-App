import type { VisibleNode } from './types';
import {
  DENSITY_BLEND_RATE,
  MIN_DENSITY,
} from './types';
import {
  QUALITY_TIER_SCALES,
  quantizeLeafDensityValue,
  selectLodQualityTier,
} from './lodBudget';

export interface BudgetEnforcementResult {
  density: number;
  visiblePointCount: number;
  qualityScale: number;
}

export function enforceLodBudget(
  nodes: VisibleNode[],
  effectiveBudget: number,
  rawCount: number,
  motionPressure: number,
  framePressure: number,
): BudgetEnforcementResult {
  const n = nodes.length;

  if (rawCount <= effectiveBudget) {
    let totalPoints = 0;
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      if (node) {
        node.qualityTier = 0;
        node.qualityScale = 1.0;
        node.density = Math.max(MIN_DENSITY, node.fadeAlpha);
        totalPoints += Math.max(1, Math.ceil(node.count * node.density));
      }
    }
    return {
      density: 1.0,
      visiblePointCount: totalPoints,
      qualityScale: 1.0,
    };
  }

  const budgetPressure = rawCount / Math.max(effectiveBudget, 1);
  let totalQualityAdjusted = 0;
  let totalSS = 0;
  let leafPointCount = 0;
  let weightedQuality = 0;
  let weightedTotalPoints = 0;

  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (!node) continue;

    if (node.isVoxel) {
      node.qualityTier = 0;
      node.qualityScale = 1.0;
      node.density = node.fadeAlpha;
      totalQualityAdjusted += Math.max(1, Math.ceil(node.count * node.density));
      continue;
    }

    const qualityTier = selectLodQualityTier(node.screenSize, budgetPressure, motionPressure, framePressure);
    node.qualityTier = qualityTier;
    node.qualityScale = QUALITY_TIER_SCALES[qualityTier]!;
    node.density = Math.max(MIN_DENSITY, node.qualityScale * node.fadeAlpha);

    const weightedCount = Math.max(1, Math.ceil(node.count * node.density));
    totalQualityAdjusted += weightedCount;
    totalSS += node.screenSize * weightedCount;
    leafPointCount += weightedCount;
    weightedQuality += node.qualityScale * node.count;
    weightedTotalPoints += node.count;
  }

  const initialQualityScale = weightedTotalPoints > 0 ? weightedQuality / weightedTotalPoints : 1.0;

  if (totalQualityAdjusted <= effectiveBudget || leafPointCount === 0) {
    return {
      density: 1.0,
      visiblePointCount: totalQualityAdjusted,
      qualityScale: initialQualityScale,
    };
  }

  const avgSS = totalSS / leafPointCount;
  const budgetRatio = effectiveBudget / totalQualityAdjusted;
  let finalVisiblePoints = 0;

  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (!node) continue;

    if (node.isVoxel) {
      finalVisiblePoints += Math.max(1, Math.ceil(node.count * node.density));
      continue;
    }

    if (node.count < 1000) {
      node.density = Math.max(MIN_DENSITY, node.qualityScale * node.fadeAlpha);
    } else {
      const ssWeight = avgSS > 0 ? node.screenSize / avgSS : 1;
      const rawDensity = budgetRatio * Math.sqrt(ssWeight);
      const qualityBudgetScale = node.qualityScale * Math.max(MIN_DENSITY, Math.min(1.0, rawDensity));
      node.density = Math.max(MIN_DENSITY, qualityBudgetScale * node.fadeAlpha);
    }

    finalVisiblePoints += Math.max(1, Math.ceil(node.count * node.density));
  }

  return {
    density: Math.max(MIN_DENSITY, Math.min(1.0, budgetRatio)),
    visiblePointCount: finalVisiblePoints,
    qualityScale: initialQualityScale,
  };
}

export function applyTemporalSmoothingToNodes(
  nodes: VisibleNode[],
  prevDensity: Float32Array,
  prevDensityValid: Uint8Array,
  swapDensity: Float32Array,
  swapDensityValid: Uint8Array,
  motionPressure: number,
  framePressure: number,
): { visiblePointCount: number; qualityScale: number } {
  swapDensityValid.fill(0);
  const n = nodes.length;
  let totalPoints = 0;
  let weightedQuality = 0;
  let weightedPoints = 0;

  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (!node) continue;
    const id = node.nodeId;

    if (prevDensityValid[id] === 1) {
      const target = node.density;
      node.density = prevDensity[id]! + (target - prevDensity[id]!) * DENSITY_BLEND_RATE;
    }

    if (!node.isVoxel) {
      node.density = quantizeLeafDensityValue(node.density, framePressure, motionPressure);
      weightedQuality += node.qualityScale * node.count;
      weightedPoints += node.count;
    }

    swapDensity[id] = node.density;
    swapDensityValid[id] = 1;
    totalPoints += Math.max(1, Math.ceil(node.count * node.density));
  }

  return {
    visiblePointCount: totalPoints,
    qualityScale: weightedPoints > 0 ? weightedQuality / weightedPoints : 1.0,
  };
}

