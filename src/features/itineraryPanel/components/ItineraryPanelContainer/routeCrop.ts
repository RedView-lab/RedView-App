import type { Itinerary } from '../../types';
import { getRoutingInputsSignature, routeStampMatches } from '../../hooks/useItineraryBrouterRouting/routingInputs';
import {
  cropRoutePoints,
  getRoutePointTotalDistanceM,
  projectTimelineLocationDistances,
} from '../../hooks/useItineraryBrouterRoutingShared';
import { buildImportedRouteMetrics, roundDistanceKm } from '@/features/itineraryPanel/lib/routes';

export interface RouteEndpointPlacement {
  /** Position sur le tracé (m) quand le point y a été pris (graphique d'analyse). */
  routeDistanceM?: number;
  /** Imprécision du clic sur la carte (m) : un clic aussi près du tracé est dessus. */
  pickToleranceM?: number;
}

/** Écart minimal sous lequel un départ / une arrivée posé(e) l'est sur le tracé. */
const ON_ROUTE_ENDPOINT_TOLERANCE_M = 15;

/**
 * Le tracé stocké est-il le résultat des lignes actuelles ? GPX importé : il
 * fait foi ; tracé BRouter : estampille à jour (ou ancien tracé sans
 * estampille, conservé tel quel à l'ouverture) et aucune édition en attente.
 */
export function storedRouteIsCurrent(itinerary: Itinerary): boolean {
  const route = itinerary.gpxRoute;
  if (!route || itinerary.pendingRoutePatch || itinerary.pendingTraceExtension) return false;
  return route.source === 'gpx'
    || route.routedInputsKey === undefined
    || routeStampMatches(itinerary, route.routedInputsKey);
}

/**
 * Rogne le tracé stocké au départ / à l'arrivée posé(e) sur lui : coupe exacte,
 * sans routage — le GPX importé reste celui du fichier, le tracé BRouter n'est
 * pas recalculé. Refusé (`null`, recalcul local à la place) quand le point
 * n'est pas sur le tracé ou qu'une étape imposée se trouve dans la partie
 * retirée : le tracé doit toujours y passer.
 */
export function cropItineraryRouteAtEndpoint(
  itinerary: Itinerary,
  endpoint: 'start' | 'end',
  point: { lat: number; lon: number },
  placement: RouteEndpointPlacement | undefined,
): { lat: number; lon: number } | null {
  const route = itinerary.gpxRoute;
  if (!route) return null;
  const keep = endpoint === 'start' ? 'after' : 'before';
  const cropped = cropRoutePoints(route.points, point, keep, {
    toleranceM: Math.max(ON_ROUTE_ENDPOINT_TOLERANCE_M, placement?.pickToleranceM ?? 0),
    hintM: placement?.routeDistanceM,
  });
  if (!cropped) return null;

  const totalM = getRoutePointTotalDistanceM(route.points);
  // Kilométrage des lignes (géodésique) et distances du tracé stocké : ~1 % d'écart.
  const marginM = 200 + (totalM * 0.01);
  const constrainsRemovedPart = itinerary.timeline.some((row) => {
    if (row.kind !== 'waypoint' || row.onRoute || row.lat == null || row.lon == null) return false;
    if (row.distanceKm == null || !Number.isFinite(row.distanceKm)) return true;
    const rowM = row.distanceKm * 1_000;
    return keep === 'after' ? rowM < cropped.cutM + marginM : rowM > cropped.cutM - marginM;
  });
  if (constrainsRemovedPart) return null;

  // Tracé complet d'un GPX importé (non simplifié) : rogné au même endroit.
  const originalPoints = route.originalPoints && route.originalPoints !== route.points
    ? cropRoutePoints(route.originalPoints, cropped.cut, keep, {
        toleranceM: ORIGINAL_POINTS_CROP_TOLERANCE_M,
        hintM: cropped.cutM * (getRoutePointTotalDistanceM(route.originalPoints) / Math.max(1, totalM)),
      })?.points ?? cropped.points
    : cropped.points;

  itinerary.gpxRoute = { ...route, points: cropped.points, originalPoints };
  delete itinerary.pendingRoutePatch;
  delete itinerary.pendingTraceExtension;
  return cropped.cut;
}

/** Écart toléré entre le tracé affiché (simplifié) et le tracé complet d'un GPX. */
const ORIGINAL_POINTS_CROP_TOLERANCE_M = 60;

/** Métriques, kilométrages et estampille du tracé rogné. */
export function finishRouteCrop(itinerary: Itinerary): void {
  const route = itinerary.gpxRoute;
  if (!route) return;
  const metrics = buildImportedRouteMetrics(route.points);
  itinerary.metrics = { ...itinerary.metrics, ...metrics };
  itinerary.timeline = projectTimelineLocationDistances(
    itinerary.timeline,
    route.points,
    metrics.distanceKm ?? roundDistanceKm(getRoutePointTotalDistanceM(route.points)),
  );
  // Le tracé rogné est celui des nouvelles lignes : pas de recalcul BRouter.
  if (route.source === 'brouter') {
    itinerary.gpxRoute = { ...route, routedInputsKey: getRoutingInputsSignature(itinerary) };
  }
}
