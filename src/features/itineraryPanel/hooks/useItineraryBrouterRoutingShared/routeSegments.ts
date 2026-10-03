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
type LatLon = { lat: number; lon: number };

/**
 * Tolérance autour de la distance mémorisée d'une borne de fenêtre : le tracé
 * a pu être ré-échantillonné entre-temps (affinage altimétrique).
 */
const PATCH_BOUNDARY_HINT_TOLERANCE_M = 5_000;
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
    const near = projectOnRouteRange(
      patchPoint,
      routePoints,
      routeDistances,
      patchPoint.distanceM - PATCH_BOUNDARY_HINT_TOLERANCE_M,
      patchPoint.distanceM + PATCH_BOUNDARY_HINT_TOLERANCE_M,
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
 */
const WINDOW_STEPS_M = [LOCAL_EDIT_WINDOW_KM * 1_000, LOCAL_EDIT_WINDOW_KM * 2_500];
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
 */
export function widenUnjoinedRoutePatchWindow(
  patch: RoutePatch,
  routePoints: RoutePoints,
  route: [number, number][],
): RoutePatch | null {
  const { window } = patch;
  if (!window || routePoints.length < 2 || route.length < 2) return null;
  const distances = getRoutePointDistances(routePoints);
  const coords = route.map(([lon, lat]) => ({ lat, lon }));

  const startProvisional = !samePatchBound(patch.start, window.start);
  const endProvisional = !samePatchBound(patch.end, window.end);
  const widenStart = startProvisional
    && !routeRejoinsStoredTrackAt(coords, routePoints, distances, patch.start, 'start');
  const widenEnd = endProvisional
    && !routeRejoinsStoredTrackAt(coords, routePoints, distances, patch.end, 'end');
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
