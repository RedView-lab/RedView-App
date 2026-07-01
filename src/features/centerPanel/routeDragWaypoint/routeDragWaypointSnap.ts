import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
} from '@/features/itineraryPanel/lib/routes';

/**
 * Geometric helpers for the press-and-drag waypoint tool.
 *
 * Two distinct snapping concerns live here:
 *
 *  1. **Hit-testing** ("is the cursor over the trace?") is handled by
 *     {@link findSplitProjectionForMapHover} in `routeSplit/routeSnap.ts`,
 *     which works in screen space and is therefore correct under 3D pitch.
 *     {@link MAX_ROUTE_GRAB_DISTANCE_PX} is the pixel tolerance reused from it.
 *
 *  2. **Exact world-space anchoring** ("where on the trace did the user grab?")
 *     is handled by {@link projectClickOntoRoute}, which projects the click
 *     onto the polyline in geographic space via `projectPointAlongRoute`.
 *     This returns the interpolated point + its cumulative distance, so the
 *     new waypoint can be inserted at its logical position along the route.
 */

/** Re-exported tolerance so the drag tool shares the split tool's hit radius. */
export {
  findSplitProjectionForMapHover,
} from '../routeSplit/routeSnap';

export interface RouteAnchorPoint {
  /** Cumulative distance along the route, in metres. */
  distanceM: number;
  lat: number;
  lon: number;
}

/**
 * Project a free geographic coordinate onto the route polyline and return the
 * exact interpolated anchor point plus its cumulative distance. Returns null
 * when the geometry is too short.
 */
export function projectClickOntoRoute(
  routePoints: Array<{ lat: number; lon: number }>,
  lon: number,
  lat: number,
): RouteAnchorPoint | null {
  if (routePoints.length < 2) return null;
  const cumulative = cumulativeRouteLengthsM(routePoints);
  const projected = projectPointAlongRoute({ lat, lon }, routePoints, cumulative);
  if (!projected) return null;
  return {
    distanceM: projected.distanceM,
    lat: projected.lat,
    lon: projected.lon,
  };
}

/**
 * Resolve the timeline index at which a new waypoint grabbed at
 * `anchorDistanceM` (cumulative distance along the route) should be inserted.
 *
 * The waypoint is placed just after the last routable row whose distance is
 * smaller than the anchor — i.e. in physical order along the route. Falls back
 * to `fallbackLength` (typically the timeline length) when the anchor is past
 * every row, which lands the waypoint at the tail.
 *
 * Mirrors the distance-driven walk used by `resolvePauseInsertIndex` in
 * `timelineMutations.ts`. Not currently used by the drag tool (the equivalent
 * walk lives inline in {@link insertWaypointAtRoutePosition}) but exposed for
 * future tools that need the raw index without splicing.
 */
export function resolveTimelineInsertIndex(
  routableRows: Array<{ distanceM: number }>,
  anchorDistanceM: number,
  fallbackLength: number,
): number {
  for (let index = 0; index < routableRows.length; index += 1) {
    if (routableRows[index].distanceM > anchorDistanceM) {
      return index;
    }
  }
  return fallbackLength;
}
