import type {
  Itinerary,
  TimelineAddItemOptions,
  TimelineAddItemKind,
  TimelineItem,
} from '../../types';
import { translateAppText } from '@/shared/i18n';
import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
} from '@/features/itineraryPanel/lib/routes';

function isRoutableTimelineRow(
  row: TimelineItem | null | undefined,
): row is TimelineItem & { lat: number; lon: number } {
  return Boolean(
    row
    && (row.kind === 'start' || row.kind === 'waypoint' || row.kind === 'end')
    && row.lat != null
    && row.lon != null,
  );
}

export function buildPendingRoutePatchForEditedRow(
  timeline: TimelineItem[],
  rowId: string,
): Itinerary['pendingRoutePatch'] {
  const routableRows = timeline.filter(isRoutableTimelineRow);
  const focusIndex = routableRows.findIndex((row) => row.id === rowId);
  if (focusIndex < 0) return undefined;

  const focus = routableRows[focusIndex];
  if (focus.kind === 'start') {
    const next = routableRows[focusIndex + 1];
    if (!next) return undefined;
    return {
      start: { lat: focus.lat, lon: focus.lon, kind: 'start' },
      end: { lat: next.lat, lon: next.lon, kind: next.kind === 'end' ? 'end' : 'waypoint' },
      via: [],
    };
  }

  if (focus.kind === 'end') {
    const previous = routableRows[focusIndex - 1];
    if (!previous) return undefined;
    return {
      start: { lat: previous.lat, lon: previous.lon, kind: previous.kind === 'start' ? 'start' : 'waypoint' },
      end: { lat: focus.lat, lon: focus.lon, kind: 'end' },
      via: [],
    };
  }

  const previous = routableRows[focusIndex - 1];
  const next = routableRows[focusIndex + 1];
  if (!previous || !next) return undefined;
  return {
    start: { lat: previous.lat, lon: previous.lon, kind: previous.kind === 'start' ? 'start' : 'waypoint' },
    end: { lat: next.lat, lon: next.lon, kind: next.kind === 'end' ? 'end' : 'waypoint' },
    via: [{ lat: focus.lat, lon: focus.lon }],
  };
}

export function buildPendingRoutePatchAfterRemoval(
  timeline: TimelineItem[],
  removedIndex: number,
  removedRow: TimelineItem | null,
): Itinerary['pendingRoutePatch'] {
  if (!isRoutableTimelineRow(removedRow)) {
    return undefined;
  }

  if (removedRow.kind === 'start') {
    const promotedStart = timeline.find((row) => row.kind === 'start');
    return promotedStart ? buildPendingRoutePatchForEditedRow(timeline, promotedStart.id) : undefined;
  }

  if (removedRow.kind === 'end') {
    const promotedEnd = timeline.find((row) => row.kind === 'end');
    return promotedEnd ? buildPendingRoutePatchForEditedRow(timeline, promotedEnd.id) : undefined;
  }

  const before = [...timeline]
    .slice(0, Math.max(0, removedIndex))
    .reverse()
    .find(isRoutableTimelineRow);
  const after = timeline
    .slice(Math.max(0, removedIndex))
    .find(isRoutableTimelineRow);
  if (!before || !after) return undefined;

  return {
    start: { lat: before.lat, lon: before.lon, kind: before.kind === 'start' ? 'start' : 'waypoint' },
    end: { lat: after.lat, lon: after.lon, kind: after.kind === 'end' ? 'end' : 'waypoint' },
    via: [],
  };
}

/**
 * Insert a brand-new `waypoint` row into the timeline at the position that
 * matches where the user grabbed the trace (expressed as a cumulative distance
 * along the route). Unlike {@link insertTimelineItem} — which always appends
 * before the `end` row — this places the row in physical order along the route
 * so the downstream patch (`buildPendingRoutePatchForEditedRow`) reroutes the
 * correct local segment.
 *
 * Returns the new row's id (or null when the geometry is unusable), so the
 * caller can feed it straight to `buildPendingRoutePatchForEditedRow`.
 *
 * @param routePoints  Active Brouter route points (must be ≥ 2).
 * @param anchorLonLat Geographic coordinate the user grabbed on the trace.
 *                     Projected onto the polyline to derive the insertion
 *                     distance — not stored on the row.
 * @param dropLatLon   Coordinate where the user released the drag. Becomes the
 *                     waypoint's persisted lat/lon (BRouter snaps it to the
 *                     nearest road server-side).
 */
export function insertWaypointAtRoutePosition(
  timeline: TimelineItem[],
  routePoints: Array<{ lat: number; lon: number }>,
  anchorLonLat: { lat: number; lon: number },
  dropLatLon: { lat: number; lon: number },
): { newRowId: string } | null {
  if (routePoints.length < 2) return null;

  const cumulative = cumulativeRouteLengthsM(routePoints);
  const anchor = projectPointAlongRoute(anchorLonLat, routePoints, cumulative);
  if (!anchor) return null;

  // Walk the timeline in order, finding the index of the first routable row
  // whose distance exceeds the anchor. The new waypoint splices in just before
  // it. `end` (distance = total) naturally acts as a sentinel for an anchor
  // near the tail.
  let insertIndex = timeline.length;
  for (let index = 0; index < timeline.length; index += 1) {
    const row = timeline[index];
    if (!isRoutableTimelineRow(row)) continue;
    const rowDistanceM = projectPointAlongRoute(
      { lat: row.lat, lon: row.lon },
      routePoints,
      cumulative,
    )?.distanceM;
    if (rowDistanceM != null && rowDistanceM > anchor.distanceM) {
      insertIndex = index;
      break;
    }
  }

  // Clamp so we never insert past the `end` row's natural tail slot.
  const endIndex = timeline.findIndex((row) => row.kind === 'end');
  if (endIndex >= 0) insertIndex = Math.min(insertIndex, endIndex);

  const newRowId = `wp-drag-${Date.now()}`;
  const newRow: TimelineItem = {
    id: newRowId,
    kind: 'waypoint',
    label: translateAppText('Nouveau point'),
    distanceKm: null,
    lat: dropLatLon.lat,
    lon: dropLatLon.lon,
  };
  timeline.splice(insertIndex, 0, newRow);
  return { newRowId };
}

export function buildTimelineAfterRemoval(
  timeline: TimelineItem[],
  rowId: string,
): TimelineItem[] | null {
  const removedIndex = timeline.findIndex((row) => row.id === rowId);
  const removedRow = removedIndex >= 0 ? timeline[removedIndex] : null;
  if (!removedRow) return null;

  if (removedRow.kind === 'start') {
    const remaining = timeline.filter((row) => row.id !== rowId);
    const promotedIndex = remaining.findIndex(isPromotableEndpointRow);
    if (promotedIndex < 0) return null;

    const promotedRow = remaining[promotedIndex];
    remaining.splice(promotedIndex, 1);
    return [
      {
        ...promotedRow,
        kind: 'start',
        distanceKm: 0,
      },
      ...remaining,
    ];
  }

  if (removedRow.kind === 'end') {
    const remaining = timeline.filter((row) => row.id !== rowId);
    const promotedIndex = findLastPromotableEndpointIndex(remaining);
    if (promotedIndex < 0) return null;

    const promotedRow = remaining[promotedIndex];
    remaining.splice(promotedIndex, 1);
    return [
      ...remaining,
      {
        ...promotedRow,
        kind: 'end',
        distanceKm: null,
      },
    ];
  }

  return timeline.filter((row) => row.id !== rowId);
}

export function insertTimelineItem(
  timeline: TimelineItem[],
  kind: TimelineAddItemKind,
  options?: TimelineAddItemOptions,
): TimelineItem | null {
  if (kind === 'start') {
    insertEndpointBeforeCurrent(timeline, 'start');
    return null;
  }

  if (kind === 'end') {
    insertEndpointBeforeCurrent(timeline, 'end');
    return null;
  }

  const nextItem = createTimelineItem(kind);
  if (!nextItem) return null;

  if (nextItem.kind === 'pause') {
    nextItem.distanceKm = resolveInitialPauseDistanceKm(timeline, options);
    timeline.splice(resolvePauseInsertIndex(timeline, nextItem.distanceKm), 0, nextItem);
    return nextItem;
  }

  const endIndex = timeline.findIndex((item) => item.kind === 'end');
  const insertAt = endIndex >= 0 ? endIndex : timeline.length;
  timeline.splice(insertAt, 0, nextItem);
  return nextItem;
}

export function moveTimelinePauseItem(
  timeline: TimelineItem[],
  rowId: string,
  distanceKm: number,
): boolean {
  const rowIndex = timeline.findIndex((item) => item.id === rowId && item.kind === 'pause');
  if (rowIndex < 0) return false;

  const [pause] = timeline.splice(rowIndex, 1);
  if (!pause || pause.kind !== 'pause') return false;

  pause.distanceKm = normalizePauseDistanceKm(distanceKm);
  timeline.splice(resolvePauseInsertIndex(timeline, pause.distanceKm), 0, pause);
  return true;
}

function insertEndpointBeforeCurrent(
  timeline: TimelineItem[],
  endpointKind: 'start' | 'end',
): void {
  const currentIndex = timeline.findIndex((item) => item.kind === endpointKind);
  const nextEndpoint = createBlankEndpoint(
    endpointKind,
    currentIndex >= 0 ? timeline[currentIndex].id : undefined,
  );

  if (currentIndex < 0) {
    if (endpointKind === 'start') timeline.unshift(nextEndpoint);
    else timeline.push(nextEndpoint);
    return;
  }

  const currentEndpoint = timeline[currentIndex];
  const promotedWaypoint = {
    ...currentEndpoint,
    id: `wp-${Date.now()}`,
    kind: 'waypoint' as const,
  };

  if (endpointKind === 'start') {
    timeline.splice(currentIndex, 1, nextEndpoint, promotedWaypoint);
    return;
  }

  timeline.splice(currentIndex, 1, promotedWaypoint, nextEndpoint);
}

function createBlankEndpoint(
  kind: 'start' | 'end',
  id?: string,
): TimelineItem {
  return {
    id: id ?? `${kind}-${Date.now()}`,
    kind,
    label: translateAppText('Rechercher un lieu'),
    distanceKm: kind === 'start' ? 0 : null,
  };
}

function createTimelineItem(kind: TimelineAddItemKind): TimelineItem | null {
  const now = Date.now();

  switch (kind) {
    case 'step':
      return {
        id: `step-${now}`,
        kind: 'waypoint',
        label: translateAppText('Rechercher un lieu'),
        distanceKm: null,
      };
    case 'waypoint':
      return {
        id: `wp-${now}`,
        kind: 'waypoint',
        label: translateAppText('Nouveau point'),
        distanceKm: null,
      };
    case 'poi':
      return {
        id: `poi-${now}`,
        kind: 'poi',
        label: 'POI',
        distanceKm: null,
      };
    case 'pause':
      return {
        id: `pause-${now}`,
        kind: 'pause',
        label: translateAppText('Pause'),
        distanceKm: null,
        durationMin: 15,
      };
    case 'start':
      return createBlankEndpoint('start');
    case 'end':
      return createBlankEndpoint('end');
    default:
      return null;
  }
}

function isPromotableEndpointRow(
  row: TimelineItem,
): row is TimelineItem & { kind: 'waypoint'; lat: number; lon: number } {
  return row.kind === 'waypoint' && row.lat != null && row.lon != null;
}

function findLastPromotableEndpointIndex(timeline: TimelineItem[]): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (isPromotableEndpointRow(timeline[index])) return index;
  }
  return -1;
}

function resolveSuggestedPauseDistanceKm(timeline: TimelineItem[]): number {
  const distances = timeline
    .map((item) => item.distanceKm)
    .filter((distance): distance is number => Number.isFinite(distance));

  if (distances.length === 0) return 0.25;

  const maxDistanceKm = Math.max(0, ...distances);
  if (maxDistanceKm <= 0.25) return 0.25;

  let candidateKm = Math.max(0.25, maxDistanceKm * 0.5);
  const occupied = new Set(distances.map((distance) => distance.toFixed(2)));
  while (occupied.has(candidateKm.toFixed(2)) && candidateKm < maxDistanceKm) {
    candidateKm = Math.min(maxDistanceKm, candidateKm + 0.25);
  }

  return Number(candidateKm.toFixed(2));
}

function resolveInitialPauseDistanceKm(
  timeline: TimelineItem[],
  options?: TimelineAddItemOptions,
): number {
  if (Number.isFinite(options?.distanceKm)) {
    return normalizePauseDistanceKm(options?.distanceKm as number);
  }
  return resolveSuggestedPauseDistanceKm(timeline);
}

function normalizePauseDistanceKm(distanceKm: number): number {
  return Math.max(0, Number(distanceKm.toFixed(3)));
}

function resolvePauseInsertIndex(timeline: TimelineItem[], distanceKm: number): number {
  const endIndex = timeline.findIndex((item) => item.kind === 'end');
  const searchEnd = endIndex >= 0 ? endIndex : timeline.length;

  for (let index = 0; index < searchEnd; index += 1) {
    const itemDistanceKm = timeline[index]?.distanceKm;
    if (Number.isFinite(itemDistanceKm) && (itemDistanceKm as number) > distanceKm) {
      return index;
    }
  }

  return searchEnd;
}