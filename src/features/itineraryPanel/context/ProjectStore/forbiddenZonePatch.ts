import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
} from '../../lib/routes';
import type {
  Itinerary,
  ItineraryForbiddenZone,
  TimelineItem,
} from '../../types';

function isRoutableTimelineRow(
  row: TimelineItem | null | undefined,
): row is TimelineItem & { lat: number; lon: number } {
  return Boolean(
    row &&
      (row.kind === 'start' || row.kind === 'waypoint' || row.kind === 'end') &&
      row.lat != null &&
      row.lon != null,
  );
}

function resolveTimelineRowDistanceM(
  row: TimelineItem & { lat: number; lon: number },
  index: number,
  rowCount: number,
  routePoints: NonNullable<Itinerary['gpxRoute']>['points'],
  routeDistances: number[],
): number | null {
  if (index === 0 || row.kind === 'start') return 0;
  if (index === rowCount - 1 || row.kind === 'end') {
    return routeDistances[routeDistances.length - 1] ?? 0;
  }
  const projected = projectPointAlongRoute(row, routePoints, routeDistances);
  return projected?.distanceM ?? null;
}

function segmentIntersectsPolygon(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
  polygon: Array<{ lat: number; lon: number }>,
): boolean {
  if (polygon.length < 3) return false;
  if (pointInPolygon(start, polygon) || pointInPolygon(end, polygon)) return true;

  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index];
    const edgeEnd = polygon[(index + 1) % polygon.length];
    if (segmentsIntersect(start, end, edgeStart, edgeEnd)) return true;
  }
  return false;
}

export function pointInPolygon(
  point: { lat: number; lon: number },
  polygon: Array<{ lat: number; lon: number }>,
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects =
      (a.lat > point.lat) !== (b.lat > point.lat) &&
      point.lon < ((b.lon - a.lon) * (point.lat - a.lat)) / ((b.lat - a.lat) || Number.EPSILON) + a.lon;
    if (intersects) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(
  a1: { lat: number; lon: number },
  a2: { lat: number; lon: number },
  b1: { lat: number; lon: number },
  b2: { lat: number; lon: number },
): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
}

function orientation(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  c: { lat: number; lon: number },
): number {
  const value = ((b.lat - a.lat) * (c.lon - b.lon)) - ((b.lon - a.lon) * (c.lat - b.lat));
  if (Math.abs(value) <= 1e-12) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  c: { lat: number; lon: number },
): boolean {
  return (
    b.lon <= Math.max(a.lon, c.lon) + 1e-12 &&
    b.lon >= Math.min(a.lon, c.lon) - 1e-12 &&
    b.lat <= Math.max(a.lat, c.lat) + 1e-12 &&
    b.lat >= Math.min(a.lat, c.lat) - 1e-12
  );
}

export function buildPendingRoutePatchForForbiddenZone(
  timeline: TimelineItem[],
  routePoints: NonNullable<Itinerary['gpxRoute']>['points'],
  zone: ItineraryForbiddenZone,
): Itinerary['pendingRoutePatch'] {
  if (routePoints.length < 2 || zone.points.length < 3) return undefined;

  const routeDistances = cumulativeRouteLengthsM(routePoints);
  let minAffectedDistanceM = Number.POSITIVE_INFINITY;
  let maxAffectedDistanceM = Number.NEGATIVE_INFINITY;

  for (let index = 1; index < routePoints.length; index += 1) {
    const start = routePoints[index - 1];
    const end = routePoints[index];
    if (!segmentIntersectsPolygon(start, end, zone.points)) continue;

    minAffectedDistanceM = Math.min(minAffectedDistanceM, routeDistances[index - 1] ?? 0);
    maxAffectedDistanceM = Math.max(maxAffectedDistanceM, routeDistances[index] ?? 0);
  }

  if (!Number.isFinite(minAffectedDistanceM) || !Number.isFinite(maxAffectedDistanceM)) {
    return undefined;
  }

  const routableRows = timeline.filter(isRoutableTimelineRow);
  const rowsWithDistances = routableRows
    .map((row, index) => {
      const distanceM = resolveTimelineRowDistanceM(row, index, routableRows.length, routePoints, routeDistances);
      return distanceM == null ? null : { row, distanceM };
    })
    .filter((entry): entry is { row: typeof routableRows[number]; distanceM: number } => Boolean(entry));
  if (rowsWithDistances.length < 2) return undefined;

  let startIndex = 0;
  for (let index = 0; index < rowsWithDistances.length; index += 1) {
    if (rowsWithDistances[index].distanceM <= minAffectedDistanceM + 1e-6) {
      startIndex = index;
    }
  }

  let endIndex = rowsWithDistances.length - 1;
  for (let index = startIndex + 1; index < rowsWithDistances.length; index += 1) {
    if (rowsWithDistances[index].distanceM >= maxAffectedDistanceM - 1e-6) {
      endIndex = index;
      break;
    }
  }

  if (endIndex <= startIndex) {
    endIndex = Math.min(rowsWithDistances.length - 1, startIndex + 1);
    startIndex = Math.max(0, endIndex - 1);
  }

  const startRow = rowsWithDistances[startIndex]?.row;
  const endRow = rowsWithDistances[endIndex]?.row;
  if (!startRow || !endRow) return undefined;

  return {
    start: { lat: startRow.lat, lon: startRow.lon, kind: startRow.kind === 'start' ? 'start' : 'waypoint' },
    end: { lat: endRow.lat, lon: endRow.lon, kind: endRow.kind === 'end' ? 'end' : 'waypoint' },
    via: rowsWithDistances
      .slice(startIndex + 1, endIndex)
      .filter((entry) => entry.row.kind === 'waypoint')
      .map((entry) => ({ lat: entry.row.lat, lon: entry.row.lon })),
  };
}