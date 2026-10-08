import type { Map as MapboxMap } from 'mapbox-gl';

/**
 * Outils d'accroche en espace écran partagés par les gestionnaires de clic et de
 * survol de l'outil de découpe. Extraits de RouteSplitToolContext pour que le
 * même calcul alimente le chemin de validation (clic) et celui d'aperçu (marqueur de survol).
 */

/** Distance maximale en pixels au tracé pour qu'un clic/survol compte comme « dessus ». */
const MAX_ROUTE_CLICK_DISTANCE_PX = 20;

export interface RouteSnapPoint {
  lat: number;
  lon: number;
}

export interface PointToSegmentProjection {
  distanceSq: number;
  t: number;
}

/**
 * Projette un point de requête (en pixels écran) sur un segment [a→b] et renvoie
 * la position paramétrique bornée `t` plus le carré de la distance en pixels au
 * point projeté.
 */
export function projectPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): PointToSegmentProjection {
  const dx = bx - ax;
  const dy = by - ay;
  const segmentLengthSq = dx * dx + dy * dy;
  if (segmentLengthSq <= 1e-6) {
    return {
      distanceSq: (px - ax) * (px - ax) + (py - ay) * (py - ay),
      t: 0,
    };
  }

  const rawT = ((px - ax) * dx + (py - ay) * dy) / segmentLengthSq;
  const t = Math.max(0, Math.min(1, rawT));
  const projectedX = ax + dx * t;
  const projectedY = ay + dy * t;
  return {
    distanceSq: (px - projectedX) * (px - projectedX) + (py - projectedY) * (py - projectedY),
    t,
  };
}

/**
 * Résout l'indice du sommet du tracé où un clic sur la carte doit découper, en
 * espace écran. Renvoie null quand le clic est plus loin que
 * MAX_ROUTE_CLICK_DISTANCE_PX du tracé (ou que la géométrie est trop courte pour
 * être découpée). Le résultat est borné à `[1, length-2]` pour que les deux
 * moitiés gardent au moins 2 points.
 */
export function findSplitIndexForMapClick(
  map: MapboxMap,
  points: RouteSnapPoint[],
  clickX: number,
  clickY: number,
): number | null {
  const projection = findNearestRouteProjection(map, points, clickX, clickY);
  if (!projection) return null;
  if (projection.distanceSq > MAX_ROUTE_CLICK_DISTANCE_PX * MAX_ROUTE_CLICK_DISTANCE_PX) return null;
  return Math.max(1, Math.min(projection.vertexIndex, points.length - 2));
}

export interface RouteHoverProjection {
  /** Carré de la distance en pixels du curseur au segment le plus proche. */
  distanceSq: number;
  /** Indice du sommet accroché (`t <= 0.5 ? i : i+1`). */
  vertexIndex: number;
  /** Vrai quand le curseur est dans la tolérance de clic du tracé. */
  withinTolerance: boolean;
  /** Coordonnées géographiques accrochées du marqueur (sommet le plus proche). */
  snapped: RouteSnapPoint;
}

/**
 * Même recherche en espace écran que {@link findSplitIndexForMapClick}, mais
 * renvoie de quoi piloter le marqueur de survol : le point accroché + si un clic
 * à cette position serait accepté. Contrairement à l'outil de clic, il ne rejette
 * PAS les positions hors tolérance — l'appelant utilise `withinTolerance` pour
 * atténuer le marqueur à la place.
 */
export function findSplitProjectionForMapHover(
  map: MapboxMap,
  points: RouteSnapPoint[],
  clickX: number,
  clickY: number,
): RouteHoverProjection | null {
  const projection = findNearestRouteProjection(map, points, clickX, clickY);
  if (!projection) return null;

  const snappedIndex = Math.max(0, Math.min(projection.vertexIndex, points.length - 1));
  const snapped = points[snappedIndex];
  if (!snapped) return null;

  return {
    distanceSq: projection.distanceSq,
    vertexIndex: snappedIndex,
    withinTolerance: projection.distanceSq <= MAX_ROUTE_CLICK_DISTANCE_PX * MAX_ROUTE_CLICK_DISTANCE_PX,
    snapped: { lat: snapped.lat, lon: snapped.lon },
  };
}

function findNearestRouteProjection(
  map: MapboxMap,
  points: RouteSnapPoint[],
  clickX: number,
  clickY: number,
): { distanceSq: number; vertexIndex: number } | null {
  if (points.length < 2) return null;

  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestIndex = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = map.project([points[index].lon, points[index].lat]);
    const end = map.project([points[index + 1].lon, points[index + 1].lat]);
    const projection = projectPointToSegment(clickX, clickY, start.x, start.y, end.x, end.y);
    if (projection.distanceSq >= bestDistanceSq) continue;
    bestDistanceSq = projection.distanceSq;
    bestIndex = projection.t <= 0.5 ? index : index + 1;
  }

  return { distanceSq: bestDistanceSq, vertexIndex: bestIndex };
}
