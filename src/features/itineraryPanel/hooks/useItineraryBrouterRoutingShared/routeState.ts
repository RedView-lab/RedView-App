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
      if (
        row.distanceKm === 0 &&
        row.lat === snappedStart?.lat &&
        row.lon === snappedStart?.lon
      ) {
        return row;
      }
      changed = true;
      return {
        ...row,
        distanceKm: 0,
        lat: snappedStart?.lat ?? row.lat,
        lon: snappedStart?.lon ?? row.lon,
      };
    }

    if (row.kind === 'end') {
      if (
        row.distanceKm === totalDistanceKm &&
        row.lat === snappedEnd?.lat &&
        row.lon === snappedEnd?.lon
      ) {
        return row;
      }
      changed = true;
      return {
        ...row,
        distanceKm: totalDistanceKm,
        lat: snappedEnd?.lat ?? row.lat,
        lon: snappedEnd?.lon ?? row.lon,
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