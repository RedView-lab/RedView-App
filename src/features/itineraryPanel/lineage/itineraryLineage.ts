import type { Itinerary } from '../types';

export interface ItineraryVisualNode {
  itinerary: Itinerary;
  depth: number;
  startDistanceKm: number;
  parentItineraryId: string | null;
  rootItineraryId: string;
}

export function getItineraryStartDistanceKm(itinerary: Itinerary): number {
  return itinerary.splitRelation?.startDistanceKm ?? 0;
}

export function getItineraryDepth(itinerary: Itinerary): number {
  return itinerary.splitRelation?.depth ?? 0;
}

export function getItineraryLocalDistanceKm(itinerary: Itinerary): number {
  const routePoints = itinerary.gpxRoute?.points;
  const routeLastDistanceM = routePoints?.[routePoints.length - 1]?.distanceM;
  if (Number.isFinite(routeLastDistanceM)) return (routeLastDistanceM as number) / 1000;

  if (Number.isFinite(itinerary.metrics?.distanceKm)) return itinerary.metrics?.distanceKm as number;

  const endDistanceKm = itinerary.timeline.find((row) => row.kind === 'end')?.distanceKm;
  return Number.isFinite(endDistanceKm) ? (endDistanceKm as number) : 0;
}

export function getItineraryEndDistanceKm(itinerary: Itinerary): number {
  return getItineraryStartDistanceKm(itinerary) + getItineraryLocalDistanceKm(itinerary);
}

export function buildItineraryVisualNodes(itineraries: Itinerary[]): ItineraryVisualNode[] {
  if (itineraries.length === 0) return [];

  const originalIndexById = new Map<string, number>();
  const itineraryById = new Map<string, Itinerary>();
  itineraries.forEach((itinerary, index) => {
    originalIndexById.set(itinerary.id, index);
    itineraryById.set(itinerary.id, itinerary);
  });

  const childrenByParentId = new Map<string | null, Itinerary[]>();
  for (const itinerary of itineraries) {
    const parentId = itinerary.splitRelation?.parentItineraryId;
    const key = parentId && itineraryById.has(parentId) ? parentId : null;
    const bucket = childrenByParentId.get(key);
    if (bucket) bucket.push(itinerary);
    else childrenByParentId.set(key, [itinerary]);
  }

  const compareItineraries = (left: Itinerary, right: Itinerary) => {
    const startDelta = getItineraryStartDistanceKm(left) - getItineraryStartDistanceKm(right);
    if (Math.abs(startDelta) > 1e-6) return startDelta;
    return (originalIndexById.get(left.id) ?? 0) - (originalIndexById.get(right.id) ?? 0);
  };

  for (const bucket of childrenByParentId.values()) {
    bucket.sort(compareItineraries);
  }

  const visited = new Set<string>();
  const result: ItineraryVisualNode[] = [];

  const visit = (itinerary: Itinerary) => {
    if (visited.has(itinerary.id)) return;
    visited.add(itinerary.id);
    result.push({
      itinerary,
      depth: getItineraryDepth(itinerary),
      startDistanceKm: getItineraryStartDistanceKm(itinerary),
      parentItineraryId: itinerary.splitRelation?.parentItineraryId ?? null,
      rootItineraryId: itinerary.splitRelation?.rootItineraryId ?? itinerary.id,
    });

    const children = childrenByParentId.get(itinerary.id) ?? [];
    for (const child of children) visit(child);
  };

  for (const itinerary of childrenByParentId.get(null) ?? []) {
    visit(itinerary);
  }

  for (const itinerary of itineraries) {
    visit(itinerary);
  }

  return result;
}

export function shiftChartX<T extends { x: number }>(entry: T, offset: number): T {
  if (!Number.isFinite(offset) || Math.abs(offset) < 1e-6) return entry;
  return {
    ...entry,
    x: entry.x + offset,
  };
}

export function shiftChartPoints<T extends { x: number }>(points: T[], offset: number): T[] {
  if (!Number.isFinite(offset) || Math.abs(offset) < 1e-6) return points;
  return points.map((point) => shiftChartX(point, offset));
}