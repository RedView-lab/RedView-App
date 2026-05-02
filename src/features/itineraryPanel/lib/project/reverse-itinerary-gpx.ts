import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
} from '../routes';

import type { Itinerary, ItineraryMetrics, ItineraryProject } from '../../types';

export function reverseItineraryGpxProject(
  project: ItineraryProject,
  itineraryId: string,
): ItineraryProject | null {
  const itinerary = project.itineraries.find((candidate) => candidate.id === itineraryId);
  const route = itinerary?.gpxRoute;
  if (!itinerary || !route || route.points.length < 2) {
    return null;
  }

  if (route.source === 'brouter') {
    return {
      ...project,
      itineraries: project.itineraries.map((candidate) =>
        candidate.id === itineraryId
          ? buildReversedBrouterItinerary(candidate)
          : candidate,
      ),
    };
  }

  const reversedPoints = normalizeImportedRoutePoints(
    route.points
      .slice()
      .reverse()
      .map((point) => ({ ...point })),
  );
  const nextMetrics = buildImportedRouteMetrics(reversedPoints);

  return {
    ...project,
    itineraries: project.itineraries.map((candidate) =>
      candidate.id === itineraryId
        ? buildReversedItinerary(candidate, reversedPoints, nextMetrics)
        : candidate,
    ),
  };
}

function buildReversedItinerary(
  itinerary: Itinerary,
  reversedPoints: NonNullable<Itinerary['gpxRoute']>['points'],
  nextMetrics: ItineraryMetrics,
): Itinerary {
  const next = structuredClone(itinerary);
  const route = next.gpxRoute;
  if (!route) return next;

  const previousStart = next.timeline.find((row) => row.kind === 'start');
  const previousEnd = next.timeline.find((row) => row.kind === 'end');

  next.gpxRoute = {
    ...route,
    points: reversedPoints,
  };
  next.metrics = next.metrics ? { ...next.metrics, ...nextMetrics } : nextMetrics;
  next.timeline = reverseTimelineEndpoints(
    next.timeline,
    reversedPoints,
    nextMetrics.distanceKm ?? null,
    previousStart?.label ?? null,
    previousEnd?.label ?? null,
  );
  delete next.pendingTraceExtension;
  delete next.pendingRoutePatch;
  delete next.routeAudit;
  invalidatePredictionState(next);

  return next;
}

function buildReversedBrouterItinerary(itinerary: Itinerary): Itinerary {
  const next = structuredClone(itinerary);
  const route = next.gpxRoute;
  if (!route || route.source !== 'brouter') return next;

  const reversedPoints = normalizeImportedRoutePoints(
    route.points
      .slice()
      .reverse()
      .map((point) => ({ ...point })),
  );

  next.gpxRoute = {
    ...route,
    points: reversedPoints,
  };
  if (next.metrics) {
    next.metrics = {
      ...next.metrics,
      ascentM: next.metrics.descentM,
      descentM: next.metrics.ascentM,
    };
    delete next.metrics.durationSec;
  }
  next.timeline = reverseBrouterTimeline(next.timeline, reversedPoints);
  delete next.pendingTraceExtension;
  delete next.pendingRoutePatch;
  delete next.routeAudit;
  invalidatePredictionState(next);

  return next;
}

function reverseTimelineEndpoints(
  timeline: Itinerary['timeline'],
  reversedPoints: NonNullable<Itinerary['gpxRoute']>['points'],
  distanceKm: number | null,
  startLabel: string | null,
  endLabel: string | null,
): Itinerary['timeline'] {
  const startPoint = reversedPoints[0];
  const endPoint = reversedPoints[reversedPoints.length - 1] ?? startPoint;
  if (!startPoint || !endPoint) {
    return structuredClone(timeline);
  }

  const hasStart = timeline.some((row) => row.kind === 'start');
  const hasEnd = timeline.some((row) => row.kind === 'end');
  if (!hasStart || !hasEnd) {
    return createImportedTimeline(reversedPoints);
  }

  return timeline.map((row) => {
    if (row.kind === 'start') {
      return {
        ...row,
        label: endLabel ?? row.label,
        lat: startPoint.lat,
        lon: startPoint.lon,
        distanceKm: 0,
      };
    }
    if (row.kind === 'end') {
      return {
        ...row,
        label: startLabel ?? row.label,
        lat: endPoint.lat,
        lon: endPoint.lon,
        distanceKm,
      };
    }
    return row;
  });
}

function reverseBrouterTimeline(
  timeline: Itinerary['timeline'],
  reversedPoints: NonNullable<Itinerary['gpxRoute']>['points'],
): Itinerary['timeline'] {
  const routedRows = timeline.filter(
    (row) => row.kind === 'start' || row.kind === 'waypoint' || row.kind === 'end',
  );
  const previousStart = routedRows.find((row) => row.kind === 'start');
  const previousEnd = routedRows.find((row) => row.kind === 'end');
  const reversedWaypoints = routedRows
    .filter((row) => row.kind === 'waypoint')
    .slice()
    .reverse();
  const startPoint = reversedPoints[0];
  const endPoint = reversedPoints[reversedPoints.length - 1] ?? startPoint;
  if (!previousStart || !previousEnd || !startPoint || !endPoint) {
    return structuredClone(timeline);
  }

  let waypointIndex = 0;
  return timeline.map((row) => {
    if (row.kind === 'start') {
      return {
        ...row,
        label: previousEnd.label,
        lat: startPoint.lat,
        lon: startPoint.lon,
        distanceKm: 0,
      };
    }
    if (row.kind === 'end') {
      return {
        ...row,
        label: previousStart.label,
        lat: endPoint.lat,
        lon: endPoint.lon,
        distanceKm:
          typeof endPoint.distanceM === 'number'
            ? Math.round((endPoint.distanceM / 1000) * 10) / 10
            : null,
      };
    }
    if (row.kind === 'waypoint') {
      const source = reversedWaypoints[waypointIndex] ?? row;
      waypointIndex += 1;
      return {
        ...row,
        label: source.label,
        lat: source.lat,
        lon: source.lon,
        distanceKm: null,
      };
    }
    return row;
  });
}

function invalidatePredictionState(itinerary: Itinerary): void {
  itinerary.prediction = null;
  itinerary.pendingFitRecompute =
    (itinerary.fitUploads?.length ?? 0) > 0 ? true : undefined;
  if (itinerary.metrics) {
    delete itinerary.metrics.durationSec;
  }
}