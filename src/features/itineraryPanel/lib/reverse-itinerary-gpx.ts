import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
} from './imported-route';

import type { Itinerary, ItineraryMetrics, ItineraryProject } from '../types';

export function reverseItineraryGpxProject(
  project: ItineraryProject,
  itineraryId: string,
): ItineraryProject | null {
  const itinerary = project.itineraries.find((candidate) => candidate.id === itineraryId);
  const route = itinerary?.gpxRoute;
  if (!itinerary || !route || route.source === 'brouter' || route.points.length < 2) {
    return null;
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
  next.prediction = null;

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