import { routeLengthM } from '@/features/poi/lib/gpx-loader';

import {
  ROUTE_SEAM_TOLERANCE_M,
  haversineRouteDistanceM,
  projectPointAlongRoute,
  roundDistanceKm,
  routeSeamJoins,
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

/** Tracé gardé au minimum par un rognage. */
const MIN_CROPPED_ROUTE_M = 50;

export interface CroppedRoute {
  points: RoutePoints;
  /** Point de coupe, sur le tracé : nouveau départ / nouvelle arrivée. */
  cut: LatLon;
  /** Position de la coupe sur le tracé d'origine (m, distances du tracé stocké). */
  cutM: number;
}

/**
 * Rognage du tracé stocké en `at` (« Démarrer ici » / « Finir ici » posé sur
 * le tracé) : `keep: 'after'` garde la suite (nouveau départ), `'before'` le
 * début (nouvelle arrivée). Coupe exacte sur le tracé lui-même, sans routage :
 * rien n'est recalculé, aucune jonction. `null` quand `at` n'est pas sur le
 * tracé (écart > `toleranceM`) ou que le reste serait trop court.
 * `hintM` : position connue sur le tracé (graphique d'analyse), pour couper
 * au bon passage d'une boucle ou d'un aller-retour.
 */
export function cropRoutePoints(
  points: RoutePoints,
  at: LatLon,
  keep: 'before' | 'after',
  options: { toleranceM: number; hintM?: number },
): CroppedRoute | null {
  if (points.length < 2) return null;
  const distances = getRoutePointDistances(points);
  const totalM = distances[distances.length - 1]!;
  const { hintM } = options;
  const rangeM = hintM != null && Number.isFinite(hintM)
    ? PATCH_BOUNDARY_HINT_TOLERANCE_M + (Math.abs(hintM) * PATCH_BOUNDARY_HINT_RELATIVE_TOLERANCE)
    : null;
  const projection = rangeM != null
    ? projectOnRouteRange(at, points, distances, hintM! - rangeM, hintM! + rangeM)
    : projectOnRouteRange(at, points, distances, 0, totalM);
  if (!projection || projection.offsetM > options.toleranceM) return null;
  const cutM = Math.min(totalM, Math.max(0, projection.alongM));
  const keptM = keep === 'after' ? totalM - cutM : cutM;
  if (keptM < MIN_CROPPED_ROUTE_M) return null;

  const cutPoint = interpolateRoutePointAtDistance(points, distances, cutM);
  if (!cutPoint) return null;
  const kept: RoutePoints = [];
  if (keep === 'after') {
    kept.push(cutPoint);
    for (let index = 0; index < points.length; index += 1) {
      if (distances[index]! > cutM + 1e-6) kept.push({ ...points[index]! });
    }
  } else {
    for (let index = 0; index < points.length && distances[index]! < cutM - 1e-6; index += 1) {
      kept.push({ ...points[index]! });
    }
    kept.push(cutPoint);
  }
  const cropped = normalizeRoutePointDistances(dedupeRoutePoints(kept));
  if (cropped.length < 2) return null;
  return { points: cropped, cut: { lat: cutPoint.lat, lon: cutPoint.lon }, cutM };
}

/** Tronçon routé parcouru au plus pour trouver où il rejoint le tracé stocké. */
const SEAM_REJOIN_SEARCH_M = 1_500;
/** Recherche de la jonction sur le tracé stocké autour de la borne (m de tracé). */
const SEAM_BOUND_SEARCH_M = 300;

export type RouteSplicePlan =
  | {
      ok: true;
      /** Coupe du tracé stocké avant le tronçon (m) ; `null` : le tronçon ouvre le tracé. */
      startCutM: number | null;
      /** Coupe après le tronçon (m) ; `null` : le tronçon ferme le tracé. */
      endCutM: number | null;
      /** Premier / dernier point du tronçon gardés (rejonction plus loin que son extrémité). */
      firstIndex: number;
      lastIndex: number;
    }
  | {
      ok: false;
      /** Jonction(s) en cause. */
      side: 'start' | 'end' | 'both';
      /** Écart de la jonction (m) : longueur de la ligne droite évitée. */
      gapM: number;
    };

/**
 * Où recoller `replacement` (tronçon routé du patch) dans le tracé stocké.
 * Une borne intermédiaire est coupée là où le tronçon rejoint vraiment le
 * tracé stocké — son premier point, à `ROUTE_SEAM_TOLERANCE_M` près (bruit
 * GPS d'un GPX importé autour de la voie où BRouter accroche), sinon le
 * premier point qui le rejoint dans les `SEAM_REJOIN_SEARCH_M` suivants,
 * jamais au-delà du premier point de passage du patch. Sans rejonction, la
 * jonction échoue : recoller tracerait une ligne droite.
 */
export function planRouteSplice(
  basePoints: RoutePoints,
  patch: RoutePatch,
  replacement: ReadonlyArray<LatLon>,
): RouteSplicePlan {
  const lastIndex = replacement.length - 1;
  if (lastIndex < 1 || basePoints.length < 2) {
    return { ok: false, side: 'both', gapM: Number.POSITIVE_INFINITY };
  }
  const distances = getRoutePointDistances(basePoints);
  // Le recollage ne doit pas sauter le passage par les points imposés du patch.
  const firstConstraint = patch.via[0] ?? patch.end;
  const lastConstraint = patch.via[patch.via.length - 1] ?? patch.start;
  const maxStartIndex = nearestPointIndex(replacement, firstConstraint);
  const minEndIndex = nearestPointIndex(replacement, lastConstraint);

  const start = patch.start.kind === 'start'
    ? { cutM: null, index: 0 }
    : findRouteSeam(basePoints, distances, patch.start, replacement, 'start', maxStartIndex);
  const end = patch.end.kind === 'end'
    ? { cutM: null, index: lastIndex }
    : findRouteSeam(basePoints, distances, patch.end, replacement, 'end', minEndIndex);
  if ('gapM' in start || 'gapM' in end) {
    const startGapM = 'gapM' in start ? start.gapM : 0;
    const endGapM = 'gapM' in end ? end.gapM : 0;
    return {
      ok: false,
      side: 'gapM' in start && 'gapM' in end ? 'both' : 'gapM' in start ? 'start' : 'end',
      gapM: Math.max(startGapM, endGapM),
    };
  }
  if (end.index - start.index < 1) return { ok: false, side: 'both', gapM: Number.POSITIVE_INFINITY };
  let endCutM = end.cutM;
  if (start.cutM != null && endCutM != null && endCutM < start.cutM) {
    // Le tronçon rejoindrait le tracé stocké avant de l'avoir quitté : bornes
    // projetées sur deux passages différents, recoller dupliquerait du tracé.
    if (endCutM < start.cutM - ROUTE_SEAM_TOLERANCE_M) {
      return { ok: false, side: 'both', gapM: start.cutM - endCutM };
    }
    endCutM = start.cutM;
  }
  return { ok: true, startCutM: start.cutM, endCutM, firstIndex: start.index, lastIndex: end.index };
}

/**
 * Premier point du tronçon (côté `side`) qui rejoint le tracé stocké près de
 * la borne, et la position (m) de la rejonction sur le tracé stocké.
 */
function findRouteSeam(
  routePoints: RoutePoints,
  distances: number[],
  bound: RoutePatchBoundary,
  replacement: ReadonlyArray<LatLon>,
  side: 'start' | 'end',
  limitIndex: number,
): { cutM: number; index: number } | { gapM: number } {
  const boundM = routePatchBoundaryDistanceM(bound, routePoints, distances);
  if (boundM == null) return { gapM: Number.POSITIVE_INFINITY };
  const step = side === 'start' ? 1 : -1;
  const first = side === 'start' ? 0 : replacement.length - 1;
  let gapM = Number.POSITIVE_INFINITY;
  let walkedM = 0;
  for (let index = first; index >= 0 && index < replacement.length; index += step) {
    if (index !== first) {
      walkedM += haversineRouteDistanceM(replacement[index - step]!, replacement[index]!);
      if (walkedM > SEAM_REJOIN_SEARCH_M) break;
    }
    if (side === 'start' ? index > limitIndex : index < limitIndex) break;
    // Fenêtre de recherche qui suit le chemin parcouru sur le tronçon.
    const rangeM = SEAM_BOUND_SEARCH_M + walkedM * 1.5;
    const projection = projectOnRouteRange(replacement[index]!, routePoints, distances, boundM - rangeM, boundM + rangeM);
    if (!projection) continue;
    if (index === first) gapM = projection.offsetM;
    if (projection.offsetM <= ROUTE_SEAM_TOLERANCE_M) return { cutM: projection.alongM, index };
  }
  return { gapM };
}

function nearestPointIndex(points: ReadonlyArray<LatLon>, target: LatLon): number {
  let bestIndex = 0;
  let bestM = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const distanceM = approxDistanceM(points[index]!, target);
    if (distanceM < bestM) {
      bestM = distanceM;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * Point de requête BRouter d'une borne de patch. Départ / arrivée : la ligne
 * elle-même (éventuellement déplacée). Borne intermédiaire : le point du
 * tracé stocké où elle se trouve — le tronçon routé en repart, la jonction
 * se fait sur le tracé (une étape d'un GPX importé peut en être éloignée :
 * en partir reliait le GPX à l'étape par une ligne droite).
 */
export function anchorRoutePatchBound(
  bound: RoutePatchBoundary,
  routePoints: RoutePoints,
): LatLon {
  const fallback = { lat: bound.lat, lon: bound.lon };
  if (bound.kind === 'start' || bound.kind === 'end' || routePoints.length < 2) return fallback;
  const distances = getRoutePointDistances(routePoints);
  const atM = routePatchBoundaryDistanceM(bound, routePoints, distances);
  const point = atM == null ? null : interpolateRoutePointAtDistance(routePoints, distances, atM);
  return point ? { lat: point.lat, lon: point.lon } : fallback;
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
type LatLon = { lat: number; lon: number };

/**
 * Tolérance autour de la distance mémorisée d'une borne de fenêtre : le tracé
 * a pu être ré-échantillonné entre-temps (affinage altimétrique).
 */
const PATCH_BOUNDARY_HINT_TOLERANCE_M = 5_000;
const PATCH_BOUNDARY_HINT_RELATIVE_TOLERANCE = 0.02;
/** Mètres par degré de latitude (projection équirectangulaire locale). */
const METRES_PER_DEGREE = 111_195;

function routePatchBoundaryDistanceM(
  patchPoint: RoutePatchBoundary,
  routePoints: RoutePoints,
  routeDistances: number[],
): number | null {
  if (patchPoint.kind === 'start') return 0;
  if (patchPoint.kind === 'end') return routeDistances[routeDistances.length - 1] ?? 0;
  if (patchPoint.distanceM != null && Number.isFinite(patchPoint.distanceM)) {
    // Kilométrage d'une ligne : distances géodésiques, quand celles du tracé
    // stocké suivent la longueur BRouter (écart relatif de l'ordre du %).
    const toleranceM = PATCH_BOUNDARY_HINT_TOLERANCE_M + (patchPoint.distanceM * PATCH_BOUNDARY_HINT_RELATIVE_TOLERANCE);
    const near = projectOnRouteRange(
      patchPoint,
      routePoints,
      routeDistances,
      patchPoint.distanceM - toleranceM,
      patchPoint.distanceM + toleranceM,
    );
    if (near) return near.alongM;
  }
  return projectPointAlongRoute(patchPoint, routePoints, routeDistances)?.distanceM ?? null;
}

/**
 * Projection de `point` sur les seuls segments du tracé situés entre `fromM`
 * et `toM` : distance le long du tracé et écart latéral (m).
 */
function projectOnRouteRange(
  point: LatLon,
  routePoints: RoutePoints,
  routeDistances: number[],
  fromM: number,
  toM: number,
): { alongM: number; offsetM: number } | null {
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestM: number | null = null;
  const first = Math.max(0, firstIndexAtOrAfter(routeDistances, fromM) - 1);
  for (let index = first; index < routePoints.length - 1; index += 1) {
    if (routeDistances[index]! > toM) break;
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
  return bestM == null ? null : { alongM: bestM, offsetM: Math.sqrt(bestDistanceSq) * METRES_PER_DEGREE };
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
/**
 * Demi-fenêtres successives (m de tracé de part et d'autre de l'édition)
 * quand une borne n'est pas rejointe naturellement ; au-delà, borne réelle.
 * On commence petit : la plupart des éditions (point glissé, trace tirée) se
 * recollent à l'ancien tracé en quelques km, et le temps d'une recherche
 * BRouter croît bien plus vite que sa longueur — une fenêtre de ±80 km
 * d'emblée coûtait plusieurs secondes par glisser. Un cran raté ne coûte
 * qu'une recherche courte de plus.
 */
const WINDOW_STEPS_M = [12_000, LOCAL_EDIT_WINDOW_KM * 1_000, LOCAL_EDIT_WINDOW_KM * 2_500];
/** Tracé que le nouveau doit partager avec l'ancien juste avant une borne provisoire. */
const REJOIN_PROOF_M = 5_000;
/** Écart latéral sous lequel deux tracés suivent la même route (GPX bruité compris). */
const REJOIN_TOLERANCE_M = 60;
/** Part de `REJOIN_PROOF_M` à partager : absorbe les points GPS aberrants. */
const REJOIN_MIN_SHARE = 0.85;

function approxDistanceM(a: LatLon, b: LatLon): number {
  const kx = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110_540);
}

function samePatchBound(a: LatLon, b: LatLon): boolean {
  return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
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
 *
 * Ces bornes sont provisoires (`window`) : le routage les recule quand le
 * nouveau tracé ne les rejoint pas en suivant déjà l'ancien (cf.
 * widenUnjoinedRoutePatchWindow), sinon elles deviendraient des points de
 * passage fantômes qui ramènent le tracé en crochet vers l'ancien.
 * Renvoie le patch inchangé quand il n'y a rien à gagner ou en cas de doute.
 */
export function narrowRoutePatchToEdit(
  patch: RoutePatch,
  routePoints: RoutePoints,
  edit: RoutePatchEdit,
): RoutePatch {
  return placeRoutePatchWindow(patch, routePoints, edit, WINDOW_STEPS_M[0]!, WINDOW_STEPS_M[0]!);
}

/**
 * Patch entre les bornes réelles de `outer`, restreint à `beforeM` / `afterM`
 * de tracé de part et d'autre de l'édition (`null` : borne réelle gardée).
 */
function placeRoutePatchWindow(
  outer: Pick<RoutePatch, 'start' | 'end' | 'via'>,
  routePoints: RoutePoints,
  edit: RoutePatchEdit,
  beforeM: number | null,
  afterM: number | null,
): RoutePatch {
  const real: RoutePatch = { start: outer.start, end: outer.end, via: outer.via };
  if (routePoints.length < 2) return real;
  const distances = getRoutePointDistances(routePoints);
  const startM = routePatchBoundaryDistanceM(real.start, routePoints, distances);
  const endM = routePatchBoundaryDistanceM(real.end, routePoints, distances);
  if (startM == null || endM == null || endM <= startM) return real;
  // Édition projetée hors du tronçon de ses voisines : autre passage, on ne touche à rien.
  if (edit.fromM < startM - EDIT_POSITION_TOLERANCE_M || edit.toM > endM + EDIT_POSITION_TOLERANCE_M) {
    return real;
  }
  const fromM = Math.min(endM, Math.max(startM, edit.fromM));
  const toM = Math.min(endM, Math.max(fromM, edit.toM));

  const startIndex = beforeM != null && fromM - beforeM > startM + MIN_WINDOW_GAIN_M
    ? Math.max(0, firstIndexAtOrAfter(distances, fromM - beforeM) - 1)
    : null;
  const endIndex = afterM != null && toM + afterM < endM - MIN_WINDOW_GAIN_M
    ? Math.min(routePoints.length - 1, firstIndexAtOrAfter(distances, toM + afterM))
    : null;
  if (startIndex == null && endIndex == null) return real;
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
      if (targets.some((target) => approxDistanceM(point, target) < REVISIT_CLEARANCE_M)) return real;
    }
  }

  const boundary = (index: number) => ({
    lat: routePoints[index]!.lat,
    lon: routePoints[index]!.lon,
    kind: 'waypoint' as const,
    distanceM: distances[index]!,
  });
  return {
    start: startIndex != null ? boundary(startIndex) : real.start,
    end: endIndex != null ? boundary(endIndex) : real.end,
    via: real.via,
    window: { start: real.start, end: real.end, fromM: edit.fromM, toM: edit.toM, projected: edit.projected },
  };
}

/**
 * Le nouveau tracé `route` atteint-il la borne provisoire `bound` en suivant
 * déjà l'ancien, dans son sens, sur `REJOIN_PROOF_M` ? Sinon la borne l'a
 * dévié : il y revient en crochet au lieu de rejoindre l'ancien là où il
 * l'aurait fait de lui-même.
 */
function routeRejoinsStoredTrackAt(
  route: LatLon[],
  routePoints: RoutePoints,
  distances: number[],
  bound: RoutePatchBoundary,
  side: 'start' | 'end',
): boolean {
  const boundM = routePatchBoundaryDistanceM(bound, routePoints, distances);
  if (boundM == null) return false;
  // Ancien tracé côté fenêtre, avec de la marge : le nouveau peut être plus long.
  const searchM = REJOIN_PROOF_M * 2;
  const rangeFromM = side === 'start' ? boundM : boundM - searchM;
  const rangeToM = side === 'start' ? boundM + searchM : boundM;
  // On parcourt le nouveau tracé depuis la borne, vers l'intérieur de la fenêtre.
  const at = (step: number) => route[side === 'start' ? step : route.length - 1 - step]!;
  let walkedM = 0;
  let sharedM = 0;
  let reachedM = 0;
  for (let step = 1; step < route.length && walkedM < REJOIN_PROOF_M; step += 1) {
    const stepM = haversineRouteDistanceM(at(step - 1), at(step));
    walkedM += stepM;
    const projection = projectOnRouteRange(at(step), routePoints, distances, rangeFromM, rangeToM);
    if (!projection || projection.offsetM > REJOIN_TOLERANCE_M) continue;
    // Même sens que l'ancien tracé : on s'éloigne de la borne en le suivant.
    const awayM = Math.abs(projection.alongM - boundM);
    if (awayM + REJOIN_TOLERANCE_M < reachedM) continue;
    reachedM = Math.max(reachedM, awayM);
    sharedM += stepM;
  }
  return walkedM > 0 && sharedM >= walkedM * REJOIN_MIN_SHARE;
}

/**
 * Après le routage d'une fenêtre locale (`route` en [lon, lat]) : chaque borne
 * provisoire que le nouveau tracé n'a pas rejointe naturellement recule d'un
 * cran (`WINDOW_STEPS_M`), puis jusqu'à la borne réelle. Une borne rejointe
 * reste en place. `null` : rien à élargir, le tracé est accepté.
 * `seamFailed` : côtés dont la jonction avec le tracé stocké a échoué (cf.
 * planRouteSplice), élargis de toute façon.
 */
export function widenUnjoinedRoutePatchWindow(
  patch: RoutePatch,
  routePoints: RoutePoints,
  route: [number, number][],
  seamFailed: { start?: boolean; end?: boolean } = {},
): RoutePatch | null {
  const { window } = patch;
  if (!window || routePoints.length < 2 || route.length < 2) return null;
  const distances = getRoutePointDistances(routePoints);
  const coords = route.map(([lon, lat]) => ({ lat, lon }));

  const startProvisional = !samePatchBound(patch.start, window.start);
  const endProvisional = !samePatchBound(patch.end, window.end);
  const widenStart = startProvisional
    && (seamFailed.start === true || !routeRejoinsStoredTrackAt(coords, routePoints, distances, patch.start, 'start'));
  const widenEnd = endProvisional
    && (seamFailed.end === true || !routeRejoinsStoredTrackAt(coords, routePoints, distances, patch.end, 'end'));
  if (!widenStart && !widenEnd) return null;

  const startM = routePatchBoundaryDistanceM(patch.start, routePoints, distances);
  const endM = routePatchBoundaryDistanceM(patch.end, routePoints, distances);
  const nextStepM = (currentM: number) => WINDOW_STEPS_M.find((stepM) => stepM > currentM + 1_000) ?? null;
  // Demi-fenêtre actuelle d'un côté : cran suivant s'il faut l'élargir, sinon inchangée.
  const sideM = (provisional: boolean, widen: boolean, currentM: number | null) => {
    if (!provisional || currentM == null) return null;
    return widen ? nextStepM(currentM) : currentM;
  };
  const widened = placeRoutePatchWindow(
    { start: window.start, end: window.end, via: patch.via },
    routePoints,
    window,
    sideM(startProvisional, widenStart, startM == null ? null : window.fromM - startM),
    sideM(endProvisional, widenEnd, endM == null ? null : endM - window.toM),
  );
  // Le côté rejoint garde exactement sa borne (pas de re-placement au point près).
  const next: RoutePatch = widened.window
    ? {
        ...widened,
        start: widenStart ? widened.start : patch.start,
        end: widenEnd ? widened.end : patch.end,
      }
    : widened;
  return samePatchBound(next.start, patch.start) && samePatchBound(next.end, patch.end) ? null : next;
}
