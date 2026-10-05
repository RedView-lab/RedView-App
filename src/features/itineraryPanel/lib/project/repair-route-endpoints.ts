/**
 * Réparation des lignes droites laissées en bout de tracé par l'ancien
 * recollage des patchs locaux : déplacer le départ (« Démarrer ici », glisser
 * le marqueur, rogner) gardait l'ancien départ comme premier point du tracé,
 * relié au nouveau par une ligne droite — de même pour l'arrivée. Ces tracés
 * sont stockés (et exportés en GPX) tels quels : la normalisation du projet
 * retire ce point.
 *
 * Un tracé BRouter part du point du réseau le plus proche du départ : son
 * deuxième point n'en est jamais nettement plus proche que le premier. Quand
 * il l'est, le premier point est l'ancien départ. Seuls les tracés routés pour
 * les lignes actuelles (estampille) et sans édition en attente sont examinés :
 * pendant une édition, l'ancien tracé attend légitimement son recalcul.
 */
import { getRoutingEndpoints, routeStampMatches } from '../../hooks/useItineraryBrouterRouting/routingInputs';
import { projectTimelineLocationDistances } from '../../hooks/useItineraryBrouterRoutingShared/routeState';
import type { Itinerary } from '../../types';
import { buildImportedRouteMetrics, haversineRouteDistanceM } from '../routes';

type RoutePoints = NonNullable<Itinerary['gpxRoute']>['points'];
type LatLon = { lat: number; lon: number };

/** Saut sous lequel un ancien départ / une ancienne arrivée ne se voit pas. */
const ARTIFACT_MIN_JUMP_M = 30;

/** Le point `outer` (extrémité du tracé) est-il un ancien départ / une ancienne arrivée ? */
function isEndpointArtifact(outer: LatLon, inner: LatLon, endpoint: LatLon): boolean {
  const outerM = haversineRouteDistanceM(outer, endpoint);
  if (outerM <= ARTIFACT_MIN_JUMP_M) return false;
  if (haversineRouteDistanceM(outer, inner) <= ARTIFACT_MIN_JUMP_M) return false;
  return haversineRouteDistanceM(inner, endpoint) * 2 < outerM;
}

function trimEndpointArtifacts(points: RoutePoints, start: LatLon | null, end: LatLon | null): RoutePoints | null {
  if (points.length < 3) return null;
  let first = 0;
  let last = points.length - 1;
  if (start && isEndpointArtifact(points[0]!, points[1]!, start)) first = 1;
  if (end && last - first >= 2 && isEndpointArtifact(points[last]!, points[last - 1]!, end)) last -= 1;
  if (first === 0 && last === points.length - 1) return null;

  const kept = points.slice(first, last + 1);
  let distanceM = 0;
  return kept.map((point, index) => {
    if (index > 0) distanceM += haversineRouteDistanceM(kept[index - 1]!, point);
    return { ...point, distanceM };
  });
}

/** Itinéraire au tracé débarrassé des lignes droites de bout ; le même s'il n'y en a pas. */
export function repairRouteEndpointArtifacts(itinerary: Itinerary): Itinerary {
  const route = itinerary.gpxRoute;
  if (!route || route.source !== 'brouter' || route.points.length < 3) return itinerary;
  if (itinerary.pendingRoutePatch || itinerary.pendingTraceExtension) return itinerary;

  const { start, end } = getRoutingEndpoints(itinerary);
  const points = trimEndpointArtifacts(route.points, start, end);
  if (!points) return itinerary;
  // Seulement un tracé routé pour ces lignes (ou ancien tracé sans estampille).
  if (route.routedInputsKey !== undefined && !routeStampMatches(itinerary, route.routedInputsKey)) {
    return itinerary;
  }

  const originalPoints = route.originalPoints && route.originalPoints !== route.points
    ? (trimEndpointArtifacts(route.originalPoints, start, end) ?? route.originalPoints)
    : points;
  const metrics = buildImportedRouteMetrics(points);
  console.info('[route] removed straight line(s) left at the route ends', {
    itineraryId: itinerary.id,
    removedPoints: route.points.length - points.length,
  });
  return {
    ...itinerary,
    gpxRoute: { ...route, points, originalPoints },
    metrics: {
      ...itinerary.metrics,
      distanceKm: metrics.distanceKm,
      ascentM: metrics.ascentM,
      descentM: metrics.descentM,
      avgSlopePercent: metrics.avgSlopePercent,
    },
    timeline: projectTimelineLocationDistances(itinerary.timeline, points, metrics.distanceKm ?? 0),
  };
}
