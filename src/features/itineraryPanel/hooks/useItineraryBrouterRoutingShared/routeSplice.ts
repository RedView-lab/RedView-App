

import { ROUTE_SEAM_TOLERANCE_M, haversineRouteDistanceM } from '../../lib/routes';

import type { RoutePoints } from './types';
import { getRoutePointDistances, interpolateRoutePointAtDistance, type RoutePatch, type RoutePatchBoundary, type LatLon, PATCH_BOUNDARY_HINT_TOLERANCE_M, PATCH_BOUNDARY_HINT_RELATIVE_TOLERANCE, routePatchBoundaryDistanceM, projectOnRouteRange, approxDistanceM, dedupeRoutePoints, normalizeRoutePointDistances } from './routeGeometry';

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
    ? projectOnRouteRange(at, points, distances, hintM! - rangeM, hintM! + rangeM, hintM)
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
    const projection = projectOnRouteRange(replacement[index]!, routePoints, distances, boundM - rangeM, boundM + rangeM, boundM);
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
