import type { Itinerary, ProjectCommentAnchor } from '@/features/itineraryPanel/types';
import {
  cumulativeRouteLengthsM,
  haversineRouteDistanceM,
  projectPointAlongRoute,
  type RouteDistancePoint,
} from '@/features/itineraryPanel/lib/routes/route-distance';

/**
 * Position d'une bulle sur un itinéraire (« km 124,3 ») : calculée à
 * l'affichage, jamais enregistrée (le tracé change, la bulle reste au même
 * endroit du terrain). Km des points du tracé (ceux du graphe) quand ils les
 * portent.
 */

/** Au-delà, la bulle n'est pas « sur » l'itinéraire. */
export const ROUTE_CONTEXT_MAX_OFFSET_M = 500;

export interface CommentRouteContext {
  distanceKm: number;
  offsetM: number;
}

const cumulativeCache = new WeakMap<readonly RouteDistancePoint[], number[]>();

function cumulativeOf(points: ReadonlyArray<RouteDistancePoint & { distanceM?: number }>): number[] {
  let cumulative = cumulativeCache.get(points);
  if (!cumulative) {
    const own = points.every((point) => Number.isFinite(point.distanceM));
    cumulative = own ? points.map((point) => point.distanceM as number) : cumulativeRouteLengthsM(points as RouteDistancePoint[]);
    cumulativeCache.set(points, cumulative);
  }
  return cumulative;
}

export function commentRouteContext(
  anchor: Pick<ProjectCommentAnchor, 'lng' | 'lat'>,
  itinerary: Pick<Itinerary, 'gpxRoute'> | null | undefined,
): CommentRouteContext | null {
  const points = itinerary?.gpxRoute?.points;
  if (!points || points.length < 2) return null;
  const target = { lat: anchor.lat, lon: anchor.lng };
  const projected = projectPointAlongRoute(target, points as RouteDistancePoint[], cumulativeOf(points));
  if (!projected) return null;
  const offsetM = haversineRouteDistanceM(target, projected);
  if (offsetM > ROUTE_CONTEXT_MAX_OFFSET_M) return null;
  return { distanceKm: projected.distanceM / 1000, offsetM };
}
