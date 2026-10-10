

import { haversineRouteDistanceM, projectPointAlongRoute } from '../../lib/routes';
import type { Itinerary } from '../../types';

import type { RoutePoint, RoutePoints } from './types';

export function getRoutePointDistances(points: RoutePoints): number[] {
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

export function interpolateRoutePointAtDistance(
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

export type RoutePatch = NonNullable<Itinerary['pendingRoutePatch']>;

export type RoutePatchBoundary = RoutePatch['start'] | RoutePatch['end'];

export type LatLon = { lat: number; lon: number };

/**
 * Tolérance autour de la distance mémorisée d'une borne de fenêtre : le tracé
 * a pu être ré-échantillonné entre-temps (affinage altimétrique).
 */
export const PATCH_BOUNDARY_HINT_TOLERANCE_M = 5_000;

export const PATCH_BOUNDARY_HINT_RELATIVE_TOLERANCE = 0.02;

/** Mètres par degré de latitude (projection équirectangulaire locale). */
const METRES_PER_DEGREE = 111_195;

export function routePatchBoundaryDistanceM(
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
      patchPoint.distanceM,
    );
    if (!near) return projectPointAlongRoute(patchPoint, routePoints, routeDistances)?.distanceM ?? null;
    // Kilométrage périmé au-delà de sa fenêtre (tracé remplacé entre la saisie
    // et le dépôt, km d'une ligne pas encore recalculé) : le meilleur segment
    // de la fenêtre peut être à des km du point. Seulement s'il vaut le
    // meilleur passage de tout le tracé.
    const global = projectPointAlongRoute(patchPoint, routePoints, routeDistances);
    if (!global) return near.alongM;
    const globalOffsetM = haversineRouteDistanceM(patchPoint, global);
    return near.offsetM <= globalOffsetM + SAME_PASS_OFFSET_SLACK_M ? near.alongM : global.distanceM;
  }
  return projectPointAlongRoute(patchPoint, routePoints, routeDistances)?.distanceM ?? null;
}

/**
 * Écart latéral (m) en deçà duquel deux passages du tracé près de `point` sont
 * jugés équivalents : sur un aller-retour, l'aller et le retour empruntent la
 * même voie (écart nul des deux côtés, ou bruit GPS d'un GPX importé).
 */
const SAME_PASS_OFFSET_SLACK_M = 20;

/**
 * Projection de `point` sur les seuls segments du tracé situés entre `fromM`
 * et `toM` : distance le long du tracé et écart latéral (m).
 * `preferM` : position connue du point sur le tracé (kilométrage mémorisé).
 * Quand le tracé passe plusieurs fois au même endroit (aller-retour, boucle,
 * détour de ravitaillement), le passage retenu est celui le plus proche de
 * `preferM` parmi ceux à `SAME_PASS_OFFSET_SLACK_M` du meilleur écart — sans
 * lui, le premier passage gagnait toujours. Chaque passage est une suite de
 * segments proches du point ; on garde le meilleur segment de chacun (jamais
 * un segment voisin sur la même voie, ce qui décalerait la position).
 */
export function projectOnRouteRange(
  point: LatLon,
  routePoints: RoutePoints,
  routeDistances: number[],
  fromM: number,
  toM: number,
  preferM?: number,
): { alongM: number; offsetM: number } | null {
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  const first = Math.max(0, firstIndexAtOrAfter(routeDistances, fromM) - 1);
  const offsetsM: number[] = [];
  const alongsM: number[] = [];
  let bestOffsetM = Number.POSITIVE_INFINITY;
  let bestM: number | null = null;
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
    const offsetM = Math.sqrt(((px - (t * dx)) ** 2) + ((py - (t * dy)) ** 2)) * METRES_PER_DEGREE;
    const alongM = routeDistances[index]! + (t * (routeDistances[index + 1]! - routeDistances[index]!));
    offsetsM.push(offsetM);
    alongsM.push(alongM);
    if (offsetM < bestOffsetM) {
      bestOffsetM = offsetM;
      bestM = alongM;
    }
  }
  if (bestM == null) return null;
  if (preferM == null || !Number.isFinite(preferM)) return { alongM: bestM, offsetM: bestOffsetM };

  // Passages : suites de segments à moins de `slack` du meilleur écart.
  const thresholdM = bestOffsetM + SAME_PASS_OFFSET_SLACK_M;
  let chosen = { alongM: bestM, offsetM: bestOffsetM };
  let chosenGapM = Math.abs(bestM - preferM);
  let passBest: { alongM: number; offsetM: number } | null = null;
  const closePass = () => {
    if (!passBest) return;
    const gapM = Math.abs(passBest.alongM - preferM);
    if (gapM < chosenGapM) {
      chosen = passBest;
      chosenGapM = gapM;
    }
    passBest = null;
  };
  for (let index = 0; index < offsetsM.length; index += 1) {
    const offsetM = offsetsM[index]!;
    if (offsetM > thresholdM) {
      closePass();
      continue;
    }
    if (!passBest || offsetM < passBest.offsetM) passBest = { alongM: alongsM[index]!, offsetM };
  }
  closePass();
  return chosen;
}

export function approxDistanceM(a: LatLon, b: LatLon): number {
  const kx = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110_540);
}

/** Premier indice dont la distance est ≥ `targetM` (distances croissantes). */
export function firstIndexAtOrAfter(distances: number[], targetM: number): number {
  let low = 0;
  let high = distances.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (distances[mid]! < targetM) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function sameFiniteNumber(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

export function sameOptionalFiniteNumber(
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

export function sameRoutePoint(left: RoutePoint | undefined, right: RoutePoint | undefined): boolean {
  if (!left || !right) return false;
  if (Math.abs(left.lat - right.lat) >= 1e-6 || Math.abs(left.lon - right.lon) >= 1e-6) {
    return false;
  }
  return (left.surface ?? 'unknown') === (right.surface ?? 'unknown');
}

export function dedupeRoutePoints(points: RoutePoints): RoutePoints {
  const deduped: RoutePoints = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (previous && sameRoutePoint(previous, point)) continue;
    deduped.push(point);
  }
  return deduped;
}

export function normalizeRoutePointDistances(points: RoutePoints): RoutePoints {
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
