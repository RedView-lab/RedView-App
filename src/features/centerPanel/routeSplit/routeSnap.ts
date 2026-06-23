import type { Map as MapboxMap } from 'mapbox-gl';

/**
 * Screen-space snapping helpers shared between the split tool's click and
 * hover handlers. Extracted from RouteSplitToolContext so the same math feeds
 * both the commit path (click) and the preview path (hover marker).
 */

/** Max pixel distance from the trace for a click/hover to count as "on it". */
export const MAX_ROUTE_CLICK_DISTANCE_PX = 20;

export interface RouteSnapPoint {
  lat: number;
  lon: number;
}

export interface PointToSegmentProjection {
  distanceSq: number;
  t: number;
}

/**
 * Project a query point (in screen pixels) onto a segment [a→b] and return the
 * clamped parametric position `t` plus the squared pixel distance to the
 * projected point.
 */
export function projectPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): PointToSegmentProjection {
  const dx = bx - ax;
  const dy = by - ay;
  const segmentLengthSq = dx * dx + dy * dy;
  if (segmentLengthSq <= 1e-6) {
    return {
      distanceSq: (px - ax) * (px - ax) + (py - ay) * (py - ay),
      t: 0,
    };
  }

  const rawT = ((px - ax) * dx + (py - ay) * dy) / segmentLengthSq;
  const t = Math.max(0, Math.min(1, rawT));
  const projectedX = ax + dx * t;
  const projectedY = ay + dy * t;
  return {
    distanceSq: (px - projectedX) * (px - projectedX) + (py - projectedY) * (py - projectedY),
    t,
  };
}

/**
 * Resolve the route vertex index a map click should split at, in screen space.
 * Returns null when the click is farther than MAX_ROUTE_CLICK_DISTANCE_PX from
 * the trace (or the geometry is too short to split). The result is clamped to
 * `[1, length-2]` so both halves keep at least 2 points.
 */
export function findSplitIndexForMapClick(
  map: MapboxMap,
  points: RouteSnapPoint[],
  clickX: number,
  clickY: number,
): number | null {
  const projection = findNearestRouteProjection(map, points, clickX, clickY);
  if (!projection) return null;
  if (projection.distanceSq > MAX_ROUTE_CLICK_DISTANCE_PX * MAX_ROUTE_CLICK_DISTANCE_PX) return null;
  return Math.max(1, Math.min(projection.vertexIndex, points.length - 2));
}

export interface RouteHoverProjection {
  /** Squared pixel distance from the cursor to the nearest segment. */
  distanceSq: number;
  /** Snapped vertex index (`t <= 0.5 ? i : i+1`). */
  vertexIndex: number;
  /** True when the cursor is within the click tolerance of the trace. */
  withinTolerance: boolean;
  /** Snapped geographic coordinates of the marker (nearest vertex). */
  snapped: RouteSnapPoint;
}

/**
 * Same screen-space search as {@link findSplitIndexForMapClick}, but returns
 * enough info to drive the hover marker: the snapped point + whether a click
 * at this position would be accepted. Unlike the click helper it does NOT
 * reject out-of-range positions — the caller uses `withinTolerance` to dim the
 * marker instead.
 */
export function findSplitProjectionForMapHover(
  map: MapboxMap,
  points: RouteSnapPoint[],
  clickX: number,
  clickY: number,
): RouteHoverProjection | null {
  const projection = findNearestRouteProjection(map, points, clickX, clickY);
  if (!projection) return null;

  const snappedIndex = Math.max(0, Math.min(projection.vertexIndex, points.length - 1));
  const snapped = points[snappedIndex];
  if (!snapped) return null;

  return {
    distanceSq: projection.distanceSq,
    vertexIndex: snappedIndex,
    withinTolerance: projection.distanceSq <= MAX_ROUTE_CLICK_DISTANCE_PX * MAX_ROUTE_CLICK_DISTANCE_PX,
    snapped: { lat: snapped.lat, lon: snapped.lon },
  };
}

function findNearestRouteProjection(
  map: MapboxMap,
  points: RouteSnapPoint[],
  clickX: number,
  clickY: number,
): { distanceSq: number; vertexIndex: number } | null {
  if (points.length < 2) return null;

  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestIndex = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = map.project([points[index].lon, points[index].lat]);
    const end = map.project([points[index + 1].lon, points[index + 1].lat]);
    const projection = projectPointToSegment(clickX, clickY, start.x, start.y, end.x, end.y);
    if (projection.distanceSq >= bestDistanceSq) continue;
    bestDistanceSq = projection.distanceSq;
    bestIndex = projection.t <= 0.5 ? index : index + 1;
  }

  return { distanceSq: bestDistanceSq, vertexIndex: bestIndex };
}
