import type {
  Itinerary,
  TimelineAddItemKind,
  TimelineItem,
} from '../../types';

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
): void {
  if (kind === 'start') {
    insertEndpointBeforeCurrent(timeline, 'start');
    return;
  }

  if (kind === 'end') {
    insertEndpointBeforeCurrent(timeline, 'end');
    return;
  }

  const nextItem = createTimelineItem(kind);
  if (!nextItem) return;

  const endIndex = timeline.findIndex((item) => item.kind === 'end');
  const insertAt = endIndex >= 0 ? endIndex : timeline.length;
  timeline.splice(insertAt, 0, nextItem);
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
    label: 'Rechercher un lieu',
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
        label: 'Rechercher un lieu',
        distanceKm: null,
      };
    case 'waypoint':
      return {
        id: `wp-${now}`,
        kind: 'waypoint',
        label: 'Nouveau point',
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
        label: 'Pause',
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