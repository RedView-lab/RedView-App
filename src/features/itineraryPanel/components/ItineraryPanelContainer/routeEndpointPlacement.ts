import type { Itinerary, TimelineItem } from '../../types';
import { insertTimelineItem } from './timelineMutations';
import { buildPendingRoutePatchForEditedRow, hasEditableRoute } from './timelineRoutePatch';
import { cropItineraryRouteAtEndpoint, finishRouteCrop, storedRouteIsCurrent, type RouteEndpointPlacement } from './routeCrop';

/**
 * « Démarrer ici » / « Finir ici » : pose le départ ou l'arrivée sur `point`
 * (ligne créée si absente). Posé sur le tracé, il le rogne là (cf.
 * cropItineraryRouteAtEndpoint) ; ailleurs, recalcul local du tracé stocké.
 */
export function placeRouteEndpoint(
  itinerary: Itinerary,
  endpoint: 'start' | 'end',
  point: { lat: number; lon: number },
  label: string,
  placement?: RouteEndpointPlacement,
): TimelineItem | null {
  let row = itinerary.timeline.find((item) => item.kind === endpoint);
  if (!row) {
    insertTimelineItem(itinerary.timeline, endpoint);
    row = itinerary.timeline.find((item) => item.kind === endpoint);
  }
  if (!row) return null;

  const routeWasCurrent = storedRouteIsCurrent(itinerary);
  row.label = label;
  row.lat = point.lat;
  row.lon = point.lon;
  row.distanceKm = endpoint === 'start' ? 0 : null;
  delete itinerary.routeAudit;
  itinerary.prediction = null;

  if (hasEditableRoute(itinerary)) {
    const cut = routeWasCurrent
      ? cropItineraryRouteAtEndpoint(itinerary, endpoint, point, placement)
      : null;
    if (cut) {
      row.lat = cut.lat;
      row.lon = cut.lon;
      finishRouteCrop(itinerary);
      return row;
    }
    delete itinerary.pendingTraceExtension;
    itinerary.pendingRoutePatch = buildPendingRoutePatchForEditedRow(itinerary, row.id);
  } else {
    delete itinerary.pendingTraceExtension;
  }
  return row;
}
