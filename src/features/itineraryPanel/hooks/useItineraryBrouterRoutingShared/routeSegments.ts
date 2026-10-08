import { routeLengthM } from '@/features/poi/lib/gpx-loader';

import { roundDistanceKm, routeSeamJoins } from '../../lib/routes';
import { computeRouteSurfaceMetricsFromBrouter } from '../../lib/route-metrics';
import type { Itinerary } from '../../types';

import type { RoutePoints } from './types';
import { planRouteSplice } from './routeSplice';
import { getRoutePointDistances, interpolateRoutePointAtDistance, type RoutePatch, routePatchBoundaryDistanceM, sameFiniteNumber, sameOptionalFiniteNumber, sameRoutePoint, dedupeRoutePoints, normalizeRoutePointDistances } from './routeGeometry';

export function routePointsEqual(
  left: RoutePoints | null | undefined,
  right: RoutePoints | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return !left && !right;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftPoint = left[index];
    const rightPoint = right[index];
    if (!sameFiniteNumber(leftPoint.lat, rightPoint.lat, 1e-6)) return false;
    if (!sameFiniteNumber(leftPoint.lon, rightPoint.lon, 1e-6)) return false;
    if (!sameOptionalFiniteNumber(leftPoint.distanceM, rightPoint.distanceM, 0.25)) return false;
    if (!sameOptionalFiniteNumber(leftPoint.elevationM, rightPoint.elevationM, 0.1)) return false;
    if (!sameOptionalFiniteNumber(leftPoint.gradientPct, rightPoint.gradientPct, 0.05)) return false;
    if ((leftPoint.surface ?? 'unknown') !== (rightPoint.surface ?? 'unknown')) return false;
  }

  return true;
}

export function getRoutePointTotalDistanceM(points: RoutePoints): number {
  const last = points[points.length - 1];
  if (last && Number.isFinite(last.distanceM)) return last.distanceM as number;
  return routeLengthM(points);
}

export function roundRouteDistanceKm(distanceM: number): number {
  return roundDistanceKm(distanceM);
}

/**
 * Recolle le tronçon routé `replacementPoints` dans le tracé stocké, entre
 * les bornes du patch, sans jamais tracer de ligne droite :
 *  - borne `start` / `end` (départ ou arrivée, éventuellement déplacés) : le
 *    tronçon ouvre / ferme le tracé, rien n'est gardé avant / après — garder
 *    l'ancien départ le reliait au nouveau par une ligne droite ;
 *  - borne intermédiaire : coupe du tracé stocké là où le tronçon le rejoint
 *    réellement (cf. planRouteSplice).
 * `null` quand une jonction ne se rejoint pas : rien n'est recollé.
 */
export function replaceRouteSegment(
  basePoints: RoutePoints,
  patch: RoutePatch,
  replacementPoints: RoutePoints,
): RoutePoints | null {
  if (basePoints.length === 0) return replacementPoints;

  const plan = planRouteSplice(basePoints, patch, replacementPoints);
  if (!plan.ok) return null;

  const baseDistances = getRoutePointDistances(basePoints);
  const prefix: RoutePoints = [];
  if (plan.startCutM != null) {
    const startCutM = plan.startCutM;
    for (let index = 0; index < basePoints.length && baseDistances[index]! < startCutM - 1e-6; index += 1) {
      prefix.push({ ...basePoints[index]! });
    }
    const startBoundaryPoint = interpolateRoutePointAtDistance(basePoints, baseDistances, startCutM);
    if (startBoundaryPoint) prefix.push(startBoundaryPoint);
  }

  const suffix: RoutePoints = [];
  if (plan.endCutM != null) {
    const endCutM = plan.endCutM;
    const endBoundaryPoint = interpolateRoutePointAtDistance(basePoints, baseDistances, endCutM);
    if (endBoundaryPoint) suffix.push(endBoundaryPoint);
    for (let index = 0; index < basePoints.length; index += 1) {
      if (baseDistances[index]! > endCutM + 1e-6) suffix.push({ ...basePoints[index]! });
    }
  }

  return normalizeRoutePointDistances(
    dedupeRoutePoints([
      ...prefix,
      ...replacementPoints.slice(plan.firstIndex, plan.lastIndex + 1).map((point) => ({ ...point })),
      ...suffix,
    ]),
  );
}

export function recomputeApproxSurfaceMetrics(
  existingMetrics: Itinerary['metrics'] | undefined,
  basePoints: RoutePoints,
  patch: NonNullable<Itinerary['pendingRoutePatch']>,
  replacementSurfaceMetrics: ReturnType<typeof computeRouteSurfaceMetricsFromBrouter>,
  replacementDistanceM: number,
): { tarmacPercent?: number; offroadPercent?: number } | undefined {
  if (!replacementSurfaceMetrics) {
    return existingMetrics
      ? {
          tarmacPercent: existingMetrics.tarmacPercent,
          offroadPercent: existingMetrics.offroadPercent,
        }
      : undefined;
  }

  const baseDistances = getRoutePointDistances(basePoints);
  const startDistanceM = routePatchBoundaryDistanceM(patch.start, basePoints, baseDistances);
  const endDistanceM = routePatchBoundaryDistanceM(patch.end, basePoints, baseDistances);
  if (startDistanceM == null || endDistanceM == null || endDistanceM < startDistanceM) {
    return {
      tarmacPercent: Math.round(replacementSurfaceMetrics.tarmacPercent),
      offroadPercent: Math.round(replacementSurfaceMetrics.offroadPercent),
    };
  }

  const remainingBaseDistanceM = Math.max(0, (baseDistances[baseDistances.length - 1] ?? 0) - (endDistanceM - startDistanceM));
  return mergeSurfaceMetrics(
    existingMetrics,
    remainingBaseDistanceM,
    replacementSurfaceMetrics,
    replacementDistanceM,
  );
}

/**
 * Prolonge le tracé stocké par `extensionPoints`, routés depuis sa fin.
 * `null` quand l'extension ne repart pas de la fin du tracé : la recoller
 * tracerait une ligne droite.
 */
export function appendRoutePoints(basePoints: RoutePoints, extensionPoints: RoutePoints): RoutePoints | null {
  if (basePoints.length === 0) return extensionPoints;
  if (extensionPoints.length === 0) return basePoints;
  if (!routeSeamJoins(basePoints[basePoints.length - 1]!, extensionPoints[0]!)) return null;

  const baseDistanceM = getRoutePointTotalDistanceM(basePoints);
  const shouldDropFirstExtensionPoint = sameRoutePoint(
    basePoints[basePoints.length - 1],
    extensionPoints[0],
  );
  const segmentTail = shouldDropFirstExtensionPoint ? extensionPoints.slice(1) : extensionPoints;
  if (segmentTail.length === 0) return basePoints;

  return [
    ...basePoints,
    ...segmentTail.map((point) => ({
      ...point,
      distanceM: baseDistanceM + (Number.isFinite(point.distanceM) ? (point.distanceM as number) : 0),
    })),
  ];
}

export function mergeSurfaceMetrics(
  existingMetrics: Itinerary['metrics'] | undefined,
  baseDistanceM: number,
  segmentSurfaceMetrics: ReturnType<typeof computeRouteSurfaceMetricsFromBrouter>,
  segmentDistanceM: number,
): { tarmacPercent?: number; offroadPercent?: number } | undefined {
  if (!segmentSurfaceMetrics) {
    return existingMetrics
      ? {
          tarmacPercent: existingMetrics.tarmacPercent,
          offroadPercent: existingMetrics.offroadPercent,
        }
      : undefined;
  }

  const baseTarmacDistanceM =
    existingMetrics?.tarmacPercent != null ? (existingMetrics.tarmacPercent / 100) * baseDistanceM : Number.NaN;
  const baseOffroadDistanceM =
    existingMetrics?.offroadPercent != null ? (existingMetrics.offroadPercent / 100) * baseDistanceM : Number.NaN;
  const segmentTarmacDistanceM =
    (segmentSurfaceMetrics.tarmacPercent / 100) * Math.max(segmentDistanceM, 0);
  const segmentOffroadDistanceM =
    (segmentSurfaceMetrics.offroadPercent / 100) * Math.max(segmentDistanceM, 0);

  if (!Number.isFinite(baseTarmacDistanceM) || !Number.isFinite(baseOffroadDistanceM)) {
    return {
      tarmacPercent: Math.round(segmentSurfaceMetrics.tarmacPercent),
      offroadPercent: Math.round(segmentSurfaceMetrics.offroadPercent),
    };
  }

  const totalClassifiedDistanceM =
    baseTarmacDistanceM +
    baseOffroadDistanceM +
    segmentTarmacDistanceM +
    segmentOffroadDistanceM;
  if (!(totalClassifiedDistanceM > 0)) return undefined;

  return {
    tarmacPercent: Math.round(((baseTarmacDistanceM + segmentTarmacDistanceM) / totalClassifiedDistanceM) * 100),
    offroadPercent: Math.round(((baseOffroadDistanceM + segmentOffroadDistanceM) / totalClassifiedDistanceM) * 100),
  };
}
