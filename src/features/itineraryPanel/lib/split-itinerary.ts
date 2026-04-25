import { ITINERARY_COLORS } from '../defaultState';
import type { Itinerary, ItineraryProject } from '../types';
import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
} from './imported-route';

export interface SplitItineraryProjectResult {
  project: ItineraryProject;
  createdItineraryId: string;
  createdItineraryName: string;
}

function buildUniqueSplitName(project: ItineraryProject, sourceName: string): string {
  const baseName = `Découpage de ${sourceName}`;
  let nextName = baseName;
  let suffix = 2;
  while (project.itineraries.some((itinerary) => itinerary.name === nextName)) {
    nextName = `${baseName} ${suffix}`;
    suffix += 1;
  }
  return nextName;
}

export function splitItineraryProject(
  project: ItineraryProject,
  itineraryId: string,
  splitIndex: number,
): SplitItineraryProjectResult | null {
  const source = project.itineraries.find((itinerary) => itinerary.id === itineraryId);
  const route = source?.gpxRoute;
  if (!source || !route || route.points.length < 4) return null;

  const safeSplitIndex = Math.max(1, Math.min(splitIndex, route.points.length - 2));
  const leftPoints = normalizeImportedRoutePoints(route.points.slice(0, safeSplitIndex + 1));
  const rightPoints = normalizeImportedRoutePoints(route.points.slice(safeSplitIndex));
  if (leftPoints.length < 2 || rightPoints.length < 2) return null;

  const createdItineraryId = `it-${Date.now()}-${project.itineraries.length + 1}`;
  const createdItineraryName = buildUniqueSplitName(project, source.name);
  const nextColor =
    ITINERARY_COLORS[project.itineraries.length % ITINERARY_COLORS.length] ?? source.color;

  const nextItineraries = project.itineraries.map((itinerary) => {
    if (itinerary.id !== itineraryId) return itinerary;
    const nextSource: Itinerary = structuredClone(itinerary);
    nextSource.gpxRoute = {
      ...route,
      points: leftPoints,
    };
    nextSource.timeline = createImportedTimeline(leftPoints);
    nextSource.metrics = buildImportedRouteMetrics(leftPoints);
    nextSource.visible = true;
    nextSource.prediction = null;
    delete nextSource.poiFeatures;
    delete nextSource.routeAudit;
    return nextSource;
  });

  const createdItinerary: Itinerary = structuredClone(source);
  createdItinerary.id = createdItineraryId;
  createdItinerary.name = createdItineraryName;
  createdItinerary.color = nextColor;
  createdItinerary.visible = false;
  createdItinerary.gpxRoute = {
    ...route,
    points: rightPoints,
  };
  createdItinerary.timeline = createImportedTimeline(rightPoints);
  createdItinerary.metrics = buildImportedRouteMetrics(rightPoints);
  createdItinerary.prediction = null;
  delete createdItinerary.poiFeatures;
  delete createdItinerary.routeAudit;

  return {
    project: {
      ...project,
      itineraries: [...nextItineraries, createdItinerary],
      activeItineraryId: createdItineraryId,
    },
    createdItineraryId,
    createdItineraryName,
  };
}