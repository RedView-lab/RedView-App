import type { Point, RouteStats } from './config';
import {
  buildAnchoredDetourPoint,
  clamp,
  computeRouteLateralBias,
  estimateRouteSpanKm,
  haversineKm,
  normalizeDetourRatios,
  sampleRouteAnchor,
} from './geometry';

// Détours candidats pour les modes « distance » et « D+ max ».

export function isExpectedDetourCandidateFailure(message: string): boolean {
  return /via\d+-position not mapped|error re-tracking track/i.test(message);
}

export function scoreMaxAscentLongDistance(route: RouteStats): number {
  const targetClimbDensity = 38;
  const flatGapM = Math.max(0, (route.distanceKm * targetClimbDensity) - route.ascentM);
  return (route.ascentM * 1150) + ((route.distanceKm * 1000) * 0.04) - (flatGapM * 1600);
}

export function computeClimbEfficiency(
  route: RouteStats,
  baseline: RouteStats,
): { addedDistanceKm: number; addedAscentM: number; gainPerAddedKm: number } {
  const addedDistanceKm = route.distanceKm - baseline.distanceKm;
  const addedAscentM = route.ascentM - baseline.ascentM;
  const gainPerAddedKm = addedAscentM / Math.max(0.5, addedDistanceKm);
  return { addedDistanceKm, addedAscentM, gainPerAddedKm };
}

export function scoreMinDistanceMaxAscent(route: RouteStats, baseline: RouteStats): number {
  const addedDistanceKm = Math.max(0, route.distanceKm - baseline.distanceKm);
  const addedAscentM = Math.max(0, route.ascentM - baseline.ascentM);
  const gainPerAddedKm = addedAscentM / Math.max(2.5, addedDistanceKm);
  const climbDensity = route.ascentM / Math.max(1, route.distanceKm);
  const softBudgetKm = Math.max(8, baseline.distanceKm * 0.08);
  const overBudgetKm = Math.max(0, addedDistanceKm - softBudgetKm);
  return (
    (gainPerAddedKm * 5200)
    + (addedAscentM * 6)
    + (climbDensity * 180)
    - (addedDistanceKm * 140)
    - (overBudgetKm * overBudgetKm * 280)
  );
}

export function buildClimbEfficiencyDetourCandidates(
  from: Point,
  to: Point,
  baseRoute: RouteStats,
): Array<{ via: Point[]; label: string; alternativeIdxs: readonly (0 | 1 | 2 | 3)[] }> {
  if (!baseRoute.coordinates || baseRoute.coordinates.length < 2) return [];
  const spanKm = estimateRouteSpanKm(from, to);
  const baseClimbDensity = baseRoute.ascentM / Math.max(1, baseRoute.distanceKm);
  const densityBoost = clamp((28 - baseClimbDensity) / 20, 0, 1);
  const tortuosity = baseRoute.distanceKm / Math.max(1, haversineKm(from, to));
  const compactness = clamp((tortuosity - 1.02) / 0.22, 0, 1);
  const scale = 1 + (densityBoost * 0.7) - (compactness * 0.18);
  const searchBreadth = clamp(0.28 + (densityBoost * 0.78) - (compactness * 0.18), 0.2, 1);
  const sideBias = computeRouteLateralBias(baseRoute.coordinates, from, to);
  const preferredSign = Math.abs(sideBias) < 1e-4 ? -1 : (sideBias > 0 ? -1 : 1);
  const hedgeSign = -preferredSign;
  const buildCandidate = (
    label: string,
    ratio: number,
    points: readonly (readonly [number, number])[],
    sign: number,
    alternativeIdxs: readonly (0 | 1 | 2 | 3)[],
  ): { via: Point[]; label: string; alternativeIdxs: readonly (0 | 1 | 2 | 3)[] } | null => {
    const offsetKm = spanKm * clamp(ratio * scale * (1 + (searchBreadth * 0.08)), 0.012, 0.058);
    const via = points.map(([along, offset]) => {
      const anchor = sampleRouteAnchor(baseRoute.coordinates ?? [], along);
      if (!anchor) return null;
      return buildAnchoredDetourPoint(anchor.anchor, anchor.tangentStart, anchor.tangentEnd, offsetKm * offset * sign);
    });
    if (via.some((point) => point == null)) return null;
    return { label, via: via as Point[], alternativeIdxs };
  };
  const preferMirrorProbe = Math.abs(sideBias) < 0.0012 || searchBreadth > 0.72;
  const shouldProbeWideSweep = searchBreadth > 0.42;
  const shouldProbeCrown = searchBreadth > 0.6;
  const shouldProbeZigzag = searchBreadth > 0.74;

  return [
    buildCandidate('adaptive-mid-tight', 0.017, [[0.5, 1]], preferredSign, [0, 1]),
    buildCandidate(
      'adaptive-mid-boost',
      0.023 + (densityBoost * 0.004),
      [[0.5, 1.12]],
      preferredSign,
      searchBreadth > 0.55 ? [0, 1, 2] : [0, 1],
    ),
    buildCandidate(
      'adaptive-mid-double',
      0.022 + (densityBoost * 0.004),
      [[0.46, 0.68], [0.6, 1.02]],
      preferredSign,
      [0, 1],
    ),
    shouldProbeWideSweep
      ? buildCandidate(
          'adaptive-early-late-sweep',
          0.021 + (densityBoost * 0.003),
          [[0.34, 0.66], [0.68, 1.02]],
          preferredSign,
          [0, 1],
        )
      : null,
    shouldProbeCrown
      ? buildCandidate(
          'adaptive-mid-crown',
          0.027 + (densityBoost * 0.005),
          [[0.32, 0.62], [0.5, -0.84], [0.72, 0.7]],
          preferredSign,
          [0, 1, 2],
        )
      : null,
    preferMirrorProbe
      ? buildCandidate(
          'adaptive-mid-hedge',
          0.021 + (densityBoost * 0.003),
          [[0.5, 0.98]],
          hedgeSign,
          [0, 1],
        )
      : null,
    searchBreadth > 0.58
      ? buildCandidate(
          'adaptive-hedge-sweep',
          0.023 + (densityBoost * 0.004),
          [[0.38, 0.74], [0.64, 1.02]],
          hedgeSign,
          [0, 1],
        )
      : null,
    shouldProbeZigzag
      ? buildCandidate(
          'adaptive-mid-zigzag',
          0.026 + (densityBoost * 0.004),
          [[0.28, 0.58], [0.52, 1.02], [0.76, 0.7]],
          preferredSign,
          [0, 1],
        )
      : null,
  ].filter((candidate): candidate is { via: Point[]; label: string; alternativeIdxs: readonly (0 | 1 | 2 | 3)[] } => candidate != null);
}

export function buildDistanceDetourCandidates(
  from: Point,
  to: Point,
  distanceFocus: number,
  climbFocus: number,
  baseRoute: RouteStats | null,
): Array<{ via: Point[]; label: string }> {
  if (!baseRoute?.coordinates || baseRoute.coordinates.length < 2) return [];
  const spanKm = estimateRouteSpanKm(from, to);
  const focusSum = distanceFocus + climbFocus;
  const isDistanceOnly = climbFocus < 0.25;
  const isExtremeClimbDistance = !isDistanceOnly && distanceFocus >= 0.9 && climbFocus >= 0.9;
  const isExtremeDistanceOnly = isDistanceOnly && distanceFocus >= 0.9;
  const buildCandidatesFromSpecs = (
    specs: Array<{ label: string; ratio: number; points: readonly (readonly [number, number])[] }>,
  ): Array<{ via: Point[]; label: string }> => {
    return specs.flatMap((spec) => {
      const offsetKm = spanKm * spec.ratio;
      const via = spec.points.map(([along, offset]) => {
        const anchor = sampleRouteAnchor(baseRoute.coordinates ?? [], along);
        if (!anchor) return null;
        return buildAnchoredDetourPoint(anchor.anchor, anchor.tangentStart, anchor.tangentEnd, offsetKm * offset);
      });
      return via.some((point) => point == null)
        ? []
        : [{ label: spec.label, via: via as Point[] }];
    });
  };
  const ultraWideRatio = !isDistanceOnly && focusSum >= 1.35
    ? 0.16 + (distanceFocus * 0.08) + (climbFocus * 0.1)
    : Number.NaN;
  const detourRatios = isDistanceOnly
    ? normalizeDetourRatios([
        0.045 + (distanceFocus * 0.035),
        0.085 + (distanceFocus * 0.07),
        0.135 + (distanceFocus * 0.105),
      ])
    : normalizeDetourRatios([
        0.06 + (distanceFocus * 0.04) + (climbFocus * 0.03),
        0.11 + (distanceFocus * 0.07) + (climbFocus * 0.06),
        ultraWideRatio,
      ]);
  const basePatterns = [
    { label: 'detour-left-early', points: [[0.33, 1]] },
    { label: 'detour-right-early', points: [[0.33, -1]] },
    { label: 'detour-left-mid', points: [[0.5, 1]] },
    { label: 'detour-right-mid', points: [[0.5, -1]] },
    { label: 'detour-left-late', points: [[0.67, 1]] },
    { label: 'detour-right-late', points: [[0.67, -1]] },
  ] as const;
  const complexPatterns = [
    { label: 's-curve-left-right', points: [[0.34, 1], [0.66, -1]] },
    { label: 's-curve-right-left', points: [[0.34, -1], [0.66, 1]] },
    { label: 'zigzag-left', points: [[0.25, 0.72], [0.5, -0.92], [0.75, 0.72]] },
    { label: 'zigzag-right', points: [[0.25, -0.72], [0.5, 0.92], [0.75, -0.72]] },
  ] as const;
  if (isExtremeClimbDistance) {
    const ultraRatio = Math.min(0.5, Math.max(detourRatios[2] ?? 0.34, 0.34) + 0.12);
    return buildCandidatesFromSpecs([
      { label: 'alpine-zigzag-left-r5', ratio: ultraRatio, points: [[0.16, 0.92], [0.36, -1.18], [0.58, 1.25], [0.8, -1.02]] },
      { label: 'alpine-zigzag-right-r5', ratio: ultraRatio, points: [[0.16, -0.92], [0.36, 1.18], [0.58, -1.25], [0.8, 1.02]] },
      { label: 'alpine-crown-left-r5', ratio: ultraRatio, points: [[0.2, 1.05], [0.42, -1.28], [0.64, 1.28], [0.84, -1.05]] },
      { label: 'alpine-crown-right-r5', ratio: ultraRatio, points: [[0.2, -1.05], [0.42, 1.28], [0.64, -1.28], [0.84, 1.05]] },
    ]);
  }
  if (isExtremeDistanceOnly) {
    const [, , ultraRatio = 0.24] = detourRatios;
    const hyperRatio = Math.min(0.5, Math.max(ultraRatio + 0.16, 0.42));
    return buildCandidatesFromSpecs([
      { label: 'zigzag-left-r4', ratio: hyperRatio, points: [[0.2, 0.96], [0.5, -1.2], [0.8, 0.96]] },
      { label: 'zigzag-right-r4', ratio: hyperRatio, points: [[0.2, -0.96], [0.5, 1.2], [0.8, -0.96]] },
      { label: 'crown-left-r4', ratio: hyperRatio, points: [[0.18, 1.05], [0.4, -1.28], [0.62, 1.28], [0.84, -1.05]] },
      { label: 'crown-right-r4', ratio: hyperRatio, points: [[0.18, -1.05], [0.4, 1.28], [0.62, -1.28], [0.84, 1.05]] },
    ]);
  }
  const patterns = isDistanceOnly ? basePatterns : [...basePatterns, ...complexPatterns];

  return detourRatios.flatMap((ratio, ratioIndex) => {
    const offsetKm = spanKm * ratio;
    return patterns.flatMap((pattern) => {
      const via = pattern.points.map(([along, offset]) => {
        const anchor = sampleRouteAnchor(baseRoute.coordinates ?? [], along);
        if (!anchor) return null;
        return buildAnchoredDetourPoint(anchor.anchor, anchor.tangentStart, anchor.tangentEnd, offsetKm * offset);
      });
      return via.some((point) => point == null)
        ? []
        : [{ label: `${pattern.label}-r${ratioIndex + 1}`, via: via as Point[] }];
    });
  });
}
