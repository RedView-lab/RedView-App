import { cumulativeRouteLengthsM, projectViaPointAlongRoute, roundDistanceKm } from '../../lib/routes';
import type { Itinerary, ItineraryRouteAuditFinding } from '../../types';

import type { RoutePoints } from './types';

export function isBrouterUnmappedPointError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('brouter http 422') && message.includes('from-position not mapped in existing datafile');
}

export function routeAuditEqual(
  left: ItineraryRouteAuditFinding[] | undefined,
  right: ItineraryRouteAuditFinding[] | undefined,
): boolean {
  const leftFindings = left ?? [];
  const rightFindings = right ?? [];
  return (
    leftFindings.length === rightFindings.length &&
    leftFindings.every((finding, index) => {
      const other = rightFindings[index];
      return (
        finding.id === other?.id &&
        finding.kind === other.kind &&
        finding.title === other.title &&
        finding.detail === other.detail &&
        finding.coordinates.length === other.coordinates.length &&
        finding.coordinates.every((coord, coordIndex) => {
          const next = other.coordinates[coordIndex];
          return coord[0] === next?.[0] && coord[1] === next?.[1];
        })
      );
    })
  );
}

export function projectTimelineLocationDistances(
  timeline: Itinerary['timeline'],
  routePoints: RoutePoints,
  totalDistanceKm: number,
): Itinerary['timeline'] {
  const cumulativeLengths = cumulativeRouteLengthsM(routePoints);
  let changed = false;
  let previousWaypointM = 0;

  const nextTimeline = timeline.map((row) => {
    if (row.kind === 'start') {
      if (row.distanceKm === 0) {
        return row;
      }
      changed = true;
      return {
        ...row,
        distanceKm: 0,
      };
    }

    if (row.kind === 'end') {
      if (row.distanceKm === totalDistanceKm) {
        return row;
      }
      changed = true;
      return {
        ...row,
        distanceKm: totalDistanceKm,
      };
    }

    if (row.kind !== 'waypoint') return row;

    // Étapes routées dans l'ordre : chacune est cherchée après la précédente,
    // au premier passage de la trace (boucle, aller-retour).
    const snappedWaypoint =
      row.lat != null && row.lon != null
        ? projectViaPointAlongRoute(
            { lat: row.lat, lon: row.lon },
            routePoints,
            cumulativeLengths,
            previousWaypointM,
          )
        : null;
    if (snappedWaypoint) previousWaypointM = snappedWaypoint.distanceM;
    const projectedDistanceKm =
      snappedWaypoint == null ? null : roundDistanceKm(snappedWaypoint.distanceM);
    if (row.distanceKm === projectedDistanceKm) {
      return row;
    }
    changed = true;
    return {
      ...row,
      distanceKm: projectedDistanceKm,
    };
  });

  return changed ? nextTimeline : timeline;
}