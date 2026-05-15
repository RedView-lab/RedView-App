import { cumulativeRouteLengthsM, projectPointAlongRoute, roundDistanceKm } from '../../lib/routes';
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
  const snappedStart = routePoints[0] ?? null;
  const snappedEnd = routePoints[routePoints.length - 1] ?? null;
  let changed = false;

  const nextTimeline = timeline.map((row) => {
    if (row.kind === 'start') {
      const nextLat = row.lat ?? snappedStart?.lat;
      const nextLon = row.lon ?? snappedStart?.lon;
      if (
        row.distanceKm === 0 &&
        row.lat === nextLat &&
        row.lon === nextLon
      ) {
        return row;
      }
      changed = true;
      return {
        ...row,
        distanceKm: 0,
        lat: nextLat,
        lon: nextLon,
      };
    }

    if (row.kind === 'end') {
      const nextLat = row.lat ?? snappedEnd?.lat;
      const nextLon = row.lon ?? snappedEnd?.lon;
      if (
        row.distanceKm === totalDistanceKm &&
        row.lat === nextLat &&
        row.lon === nextLon
      ) {
        return row;
      }
      changed = true;
      return {
        ...row,
        distanceKm: totalDistanceKm,
        lat: nextLat,
        lon: nextLon,
      };
    }

    if (row.kind !== 'waypoint') return row;

    const snappedWaypoint =
      row.lat != null && row.lon != null
        ? projectPointAlongRoute(
            { lat: row.lat, lon: row.lon },
            routePoints,
            cumulativeLengths,
          )
        : null;
    const projectedDistanceKm =
      snappedWaypoint == null ? null : roundDistanceKm(snappedWaypoint.distanceM);
    if (
      row.distanceKm === projectedDistanceKm &&
      row.lat === snappedWaypoint?.lat &&
      row.lon === snappedWaypoint?.lon
    ) {
      return row;
    }
    changed = true;
    return {
      ...row,
      distanceKm: projectedDistanceKm,
      lat: snappedWaypoint?.lat ?? row.lat,
      lon: snappedWaypoint?.lon ?? row.lon,
    };
  });

  return changed ? nextTimeline : timeline;
}