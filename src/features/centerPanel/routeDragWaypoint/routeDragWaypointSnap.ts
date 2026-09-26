import type { Map as MapboxMap } from 'mapbox-gl';
import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
} from '@/features/itineraryPanel/lib/routes';
import type { TimelineItem } from '@/features/itineraryPanel/types';
import { projectPointToSegment } from '../routeSplit/routeSnap';

/** Maximum screen distance in pixels from the trace line for hover/drag detection. */
export const MAX_ROUTE_DRAG_CLICK_DISTANCE_PX = 28;

export interface ContinuousRouteProjection {
  /** Squared pixel distance from the cursor to the nearest segment. */
  distanceSq: number;
  /** Segment index start (between points[i] and points[i+1]). */
  segmentIndex: number;
  /** Parametric factor along segment, between 0 and 1. */
  t: number;
  /** True when cursor is within tolerance of the route line. */
  withinTolerance: boolean;
  /** Snapped geographic coordinates (continuously interpolated on the segment). */
  snapped: { lat: number; lon: number };
}

/**
 * Projects a cursor position (screen coordinates relative to canvas) continuously
 * onto the polyline in screen space. Glides smoothly along segments without jumping
 * between vertices, matching Strava and Komoot behavior.
 */
export function findContinuousRouteProjection(
  map: MapboxMap,
  points: Array<{ lat: number; lon: number }>,
  screenX: number,
  screenY: number,
  tolerancePx: number = MAX_ROUTE_DRAG_CLICK_DISTANCE_PX,
): ContinuousRouteProjection | null {
  if (points.length < 2) return null;

  let bounds;
  try {
    bounds = map.getBounds();
  } catch {
    return null;
  }
  if (!bounds) return null;

  const marginLon = Math.max(0.01, (bounds.getEast() - bounds.getWest()) * 0.15);
  const marginLat = Math.max(0.01, (bounds.getNorth() - bounds.getSouth()) * 0.15);
  const west = bounds.getWest() - marginLon;
  const east = bounds.getEast() + marginLon;
  const south = bounds.getSouth() - marginLat;
  const north = bounds.getNorth() + marginLat;

  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestSegment = 0;
  let bestT = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];

    const minLon = Math.min(p0.lon, p1.lon);
    const maxLon = Math.max(p0.lon, p1.lon);
    const minLat = Math.min(p0.lat, p1.lat);
    const maxLat = Math.max(p0.lat, p1.lat);

    if (maxLon < west || minLon > east || maxLat < south || minLat > north) {
      continue;
    }

    try {
      const s0 = map.project([p0.lon, p0.lat]);
      const s1 = map.project([p1.lon, p1.lat]);

      const projection = projectPointToSegment(screenX, screenY, s0.x, s0.y, s1.x, s1.y);
      if (projection.distanceSq < bestDistanceSq) {
        bestDistanceSq = projection.distanceSq;
        bestSegment = i;
        bestT = projection.t;
      }
    } catch {
      /* ignore projection error on out-of-world points */
    }
  }

  if (!Number.isFinite(bestDistanceSq)) return null;

  const p0 = points[bestSegment];
  const p1 = points[bestSegment + 1];
  const snappedLat = p0.lat + bestT * (p1.lat - p0.lat);
  const snappedLon = p0.lon + bestT * (p1.lon - p0.lon);

  return {
    distanceSq: bestDistanceSq,
    segmentIndex: bestSegment,
    t: bestT,
    withinTolerance: bestDistanceSq <= tolerancePx * tolerancePx,
    snapped: { lat: snappedLat, lon: snappedLon },
  };
}

/**
 * Checks if a click is within proximity of an existing routable checkpoint
 * (start, end, or waypoint) to avoid creating unintentional duplicate waypoints.
 */
export function isClickNearExistingTimelinePoint(
  map: MapboxMap,
  timeline: TimelineItem[],
  clickX: number,
  clickY: number,
  thresholdPx = 14,
): boolean {
  const thresholdSq = thresholdPx * thresholdPx;
  for (const item of timeline) {
    if (item.lat == null || item.lon == null) continue;
    if (item.kind !== 'start' && item.kind !== 'end' && item.kind !== 'waypoint') continue;
    try {
      const pt = map.project([item.lon, item.lat]);
      const dx = clickX - pt.x;
      const dy = clickY - pt.y;
      if (dx * dx + dy * dy <= thresholdSq) {
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

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
