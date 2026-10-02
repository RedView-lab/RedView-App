import { routeLengthM } from '@/features/poi/lib/gpx-loader';

import {
  haversineRouteDistanceM,
  projectPointAlongRoute,
  roundDistanceKm,
} from '../../lib/routes';
import { LOCAL_EDIT_WINDOW_KM } from '../../lib/brouter';
import { computeRouteSurfaceMetricsFromBrouter } from '../../lib/route-metrics';
import type { Itinerary } from '../../types';

import type { RoutePoint, RoutePoints } from './types';

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

export function replaceRouteSegment(
  basePoints: RoutePoints,
  patch: NonNullable<Itinerary['pendingRoutePatch']>,
  replacementPoints: RoutePoints,
): RoutePoints {
  if (basePoints.length === 0) return replacementPoints;

  const baseDistances = getRoutePointDistances(basePoints);
  const startDistanceM = routePatchBoundaryDistanceM(patch.start, basePoints, baseDistances);
  const endDistanceM = routePatchBoundaryDistanceM(patch.end, basePoints, baseDistances);
  if (startDistanceM == null || endDistanceM == null || endDistanceM < startDistanceM) {
    return replacementPoints;
  }

  const prefix = basePoints
    .filter((_, index) => baseDistances[index] < startDistanceM - 1e-6)
    .map((point) => ({ ...point }));
  const startBoundaryPoint = interpolateRoutePointAtDistance(basePoints, baseDistances, startDistanceM);
  if (startBoundaryPoint) prefix.push(startBoundaryPoint);

  const endBoundaryPoint = interpolateRoutePointAtDistance(basePoints, baseDistances, endDistanceM);
  const suffix = basePoints
    .filter((_, index) => baseDistances[index] > endDistanceM + 1e-6)
    .map((point) => ({ ...point }));
  if (endBoundaryPoint) suffix.unshift(endBoundaryPoint);

  return normalizeRoutePointDistances(
    dedupeRoutePoints([
      ...prefix,
      ...replacementPoints.map((point) => ({ ...point })),
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

export function appendRoutePoints(basePoints: RoutePoints, extensionPoints: RoutePoints): RoutePoints {
  if (basePoints.length === 0) return extensionPoints;
  if (extensionPoints.length === 0) return basePoints;

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

function sameFiniteNumber(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

function sameOptionalFiniteNumber(
  left: number | null | undefined,
  right: number | null | undefined,
  tolerance: number,
): boolean {
  const leftFinite = Number.isFinite(left);
  const rightFinite = Number.isFinite(right);
  if (leftFinite !== rightFinite) return false;
  if (!leftFinite && !rightFinite) return true;
  return Math.abs((left as number) - (right as number)) <= tolerance;
}

function sameRoutePoint(left: RoutePoint | undefined, right: RoutePoint | undefined): boolean {
  if (!left || !right) return false;
  if (Math.abs(left.lat - right.lat) >= 1e-6 || Math.abs(left.lon - right.lon) >= 1e-6) {
    return false;
  }
  return (left.surface ?? 'unknown') === (right.surface ?? 'unknown');
}

function getRoutePointDistances(points: RoutePoints): number[] {
  if (points.length === 0) return [];

  const distances = new Array<number>(points.length);
  distances[0] = 0;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const nextDistance = point.distanceM;
    if (Number.isFinite(nextDistance) && (nextDistance as number) >= distances[index - 1]) {
      distances[index] = nextDistance as number;
      continue;
    }
    distances[index] = distances[index - 1] + haversineRouteDistanceM(points[index - 1], point);
  }
  return distances;
}

function interpolateRoutePointAtDistance(
  points: RoutePoints,
  distances: number[],
  targetDistanceM: number,
): RoutePoint | null {
  if (points.length === 0 || distances.length !== points.length) return null;
  if (targetDistanceM <= distances[0]) return { ...points[0], distanceM: 0 };
  const lastIndex = points.length - 1;
  if (targetDistanceM >= distances[lastIndex]) {
    return { ...points[lastIndex], distanceM: distances[lastIndex] };
  }

  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (distances[mid] <= targetDistanceM) low = mid;
    else high = mid;
  }

  const startPoint = points[low];
  const endPoint = points[high];
  const spanM = distances[high] - distances[low];
  if (spanM <= 0) return { ...startPoint, distanceM: targetDistanceM };
  const t = Math.max(0, Math.min(1, (targetDistanceM - distances[low]) / spanM));

  return {
    lat: startPoint.lat + ((endPoint.lat - startPoint.lat) * t),
    lon: startPoint.lon + ((endPoint.lon - startPoint.lon) * t),
    distanceM: targetDistanceM,
    elevationM:
      Number.isFinite(startPoint.elevationM) && Number.isFinite(endPoint.elevationM)
        ? (startPoint.elevationM as number) + (((endPoint.elevationM as number) - (startPoint.elevationM as number)) * t)
        : startPoint.elevationM ?? endPoint.elevationM ?? null,
    gradientPct:
      Number.isFinite(startPoint.gradientPct) && Number.isFinite(endPoint.gradientPct)
        ? (startPoint.gradientPct as number) + (((endPoint.gradientPct as number) - (startPoint.gradientPct as number)) * t)
        : startPoint.gradientPct ?? endPoint.gradientPct ?? null,
    surface:
      t < 0.5
        ? (startPoint.surface ?? endPoint.surface ?? 'unknown')
        : (endPoint.surface ?? startPoint.surface ?? 'unknown'),
  };
}

function dedupeRoutePoints(points: RoutePoints): RoutePoints {
  const deduped: RoutePoints = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (previous && sameRoutePoint(previous, point)) continue;
    deduped.push(point);
  }
  return deduped;
}

function normalizeRoutePointDistances(points: RoutePoints): RoutePoints {
  if (points.length === 0) return [];
  let cumulativeDistanceM = 0;
  return points.map((point, index) => {
    if (index > 0) {
      cumulativeDistanceM += haversineRouteDistanceM(points[index - 1], point);
    }
    return {
      ...point,
      distanceM: cumulativeDistanceM,
    };
  });
}

type RoutePatch = NonNullable<Itinerary['pendingRoutePatch']>;
type RoutePatchBoundary = RoutePatch['start'] | RoutePatch['end'];

/**
 * Tolérance autour de la distance mémorisée d'une borne de fenêtre : le tracé
 * a pu être ré-échantillonné entre-temps (affinage altimétrique).
 */
const PATCH_BOUNDARY_HINT_TOLERANCE_M = 5_000;

function routePatchBoundaryDistanceM(
  patchPoint: RoutePatchBoundary,
  routePoints: RoutePoints,
  routeDistances: number[],
): number | null {
  if (patchPoint.kind === 'start') return 0;
  if (patchPoint.kind === 'end') return routeDistances[routeDistances.length - 1] ?? 0;
  if (patchPoint.distanceM != null && Number.isFinite(patchPoint.distanceM)) {
    const near = projectNearDistanceM(
      patchPoint,
      routePoints,
      routeDistances,
      patchPoint.distanceM,
      PATCH_BOUNDARY_HINT_TOLERANCE_M,
    );
    if (near != null) return near;
  }
  return projectPointAlongRoute(patchPoint, routePoints, routeDistances)?.distanceM ?? null;
}

/** Projection de `point` sur les seuls segments situés à ±`toleranceM` de `hintM`. */
function projectNearDistanceM(
  point: { lat: number; lon: number },
  routePoints: RoutePoints,
  routeDistances: number[],
  hintM: number,
  toleranceM: number,
): number | null {
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestM: number | null = null;
  const first = Math.max(0, firstIndexAtOrAfter(routeDistances, hintM - toleranceM) - 1);
  for (let index = first; index < routePoints.length - 1; index += 1) {
    if (routeDistances[index]! > hintM + toleranceM) break;
    const a = routePoints[index]!;
    const b = routePoints[index + 1]!;
    const dx = (b.lon - a.lon) * cosLat;
    const dy = b.lat - a.lat;
    const px = (point.lon - a.lon) * cosLat;
    const py = point.lat - a.lat;
    const lengthSq = (dx * dx) + (dy * dy);
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px * dx) + (py * dy)) / lengthSq)) : 0;
    const distanceSq = ((px - (t * dx)) ** 2) + ((py - (t * dy)) ** 2);
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestM = routeDistances[index]! + (t * (routeDistances[index + 1]! - routeDistances[index]!));
    }
  }
  return bestM;
}

/** Premier indice dont la distance est ≥ `targetM` (distances croissantes). */
function firstIndexAtOrAfter(distances: number[], targetM: number): number {
  let low = 0;
  let high = distances.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (distances[mid]! < targetM) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Une fenêtre n'a d'intérêt que si elle épargne au moins ça de tracé. */
const MIN_WINDOW_GAIN_M = 20_000;
/** Distance sous laquelle le tracé « repasse » par la position éditée. */
const REVISIT_CLEARANCE_M = 1_000;
/** Écart toléré entre le kilométrage d'une ligne et les distances du tracé. */
const EDIT_POSITION_TOLERANCE_M = 5_000;

function approxDistanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const kx = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110_540);
}

export interface RoutePatchEdit {
  /** Portion du tracé stocké que l'édition invalide (m depuis le départ). */
  fromM: number;
  toM: number;
  /**
   * Position déduite d'une projection (kilométrage d'une ligne) : sur une
   * boucle ou un aller-retour, elle peut désigner le mauvais passage. La
   * fenêtre n'est alors posée que si le tracé ne repasse pas par là ailleurs.
   */
  projected: boolean;
}

/**
 * Fenêtre locale, même méthode que les ancres des très longs tracés appliquée
 * au tracé stocké. Un patch reroute tout le tronçon entre les lignes voisines
 * de l'édition — sur un tracé géant sans étape, tout le tracé. Le tracé stocké
 * étant déjà le meilleur pour ce profil, ses bornes sont rapprochées à
 * `LOCAL_EDIT_WINDOW_KM` de part et d'autre de la portion éditée, prises sur
 * le tracé lui-même : le reste est conservé tel quel, et la recherche reste
 * courte (pas de délai dépassé, heuristique peu gloutonne).
 * Renvoie le patch inchangé quand il n'y a rien à gagner ou en cas de doute.
 */
export function narrowRoutePatchToEdit(
  patch: RoutePatch,
  routePoints: RoutePoints,
  edit: RoutePatchEdit,
): RoutePatch {
  if (routePoints.length < 2) return patch;
  const distances = getRoutePointDistances(routePoints);
  const startM = routePatchBoundaryDistanceM(patch.start, routePoints, distances);
  const endM = routePatchBoundaryDistanceM(patch.end, routePoints, distances);
  if (startM == null || endM == null || endM <= startM) return patch;
  // Édition projetée hors du tronçon de ses voisines : autre passage, on ne touche à rien.
  if (edit.fromM < startM - EDIT_POSITION_TOLERANCE_M || edit.toM > endM + EDIT_POSITION_TOLERANCE_M) {
    return patch;
  }
  const fromM = Math.min(endM, Math.max(startM, edit.fromM));
  const toM = Math.min(endM, Math.max(fromM, edit.toM));

  const windowM = LOCAL_EDIT_WINDOW_KM * 1_000;
  const startIndex = fromM - windowM > startM + MIN_WINDOW_GAIN_M
    ? Math.max(0, firstIndexAtOrAfter(distances, fromM - windowM) - 1)
    : null;
  const endIndex = toM + windowM < endM - MIN_WINDOW_GAIN_M
    ? Math.min(routePoints.length - 1, firstIndexAtOrAfter(distances, toM + windowM))
    : null;
  if (startIndex == null && endIndex == null) return patch;
  const windowStartM = startIndex != null ? distances[startIndex]! : startM;
  const windowEndM = endIndex != null ? distances[endIndex]! : endM;

  if (edit.projected) {
    const targets = [fromM, toM]
      .map((distanceM) => interpolateRoutePointAtDistance(routePoints, distances, distanceM))
      .filter((target): target is RoutePoint => target !== null);
    for (let index = 0; index < routePoints.length; index += 1) {
      const distanceM = distances[index]!;
      if (distanceM < startM || distanceM > endM) continue;
      if (distanceM >= windowStartM && distanceM <= windowEndM) continue;
      const point = routePoints[index]!;
      if (targets.some((target) => approxDistanceM(point, target) < REVISIT_CLEARANCE_M)) return patch;
    }
  }

  const boundary = (index: number) => ({
    lat: routePoints[index]!.lat,
    lon: routePoints[index]!.lon,
    kind: 'waypoint' as const,
    distanceM: distances[index]!,
  });
  return {
    ...patch,
    start: startIndex != null ? boundary(startIndex) : patch.start,
    end: endIndex != null ? boundary(endIndex) : patch.end,
  };
}