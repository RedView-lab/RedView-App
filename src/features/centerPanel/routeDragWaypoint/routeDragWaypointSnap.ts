import type { Map as MapboxMap } from 'mapbox-gl';
import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
} from '@/features/itineraryPanel/lib/routes';
import type { TimelineItem } from '@/features/itineraryPanel/types';
import { projectPointToSegment } from '../routeSplit/routeSnap';

/** Maximum screen distance in pixels from the trace line for hover/drag detection. */
export const MAX_ROUTE_DRAG_CLICK_DISTANCE_PX = 28;
/** Tolerance in pixels to enter route hover mode (strict to avoid accidental triggers). */
export const ROUTE_DRAG_HOVER_ENTER_DISTANCE_PX = 22;
/** Tolerance in pixels to exit route hover mode (generous hysteresis to eliminate border flicker). */
export const ROUTE_DRAG_HOVER_EXIT_DISTANCE_PX = 34;

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
interface ScreenProjectionCache {
  key: string;
  builtAt: number;
  xs: Float64Array;
  ys: Float64Array;
}

/**
 * Projections écran mises en cache par état caméra : le survol appelait
 * `map.project` deux fois par segment à chaque frame (échantillonnage DEM en
 * 3D), ce qui faisait laguer le survol et « clignoter » le curseur. Tant que la
 * caméra ne bouge pas, on réutilise le tableau (courte expiration pour suivre
 * le chargement des tuiles de relief).
 */
const screenProjectionCache = new WeakMap<object, ScreenProjectionCache>();
const SCREEN_PROJECTION_CACHE_TTL_MS = 400;

function cameraKey(map: MapboxMap): string {
  const center = map.getCenter();
  const canvas = map.getCanvas();
  return [
    center.lng.toFixed(7),
    center.lat.toFixed(7),
    map.getZoom().toFixed(4),
    map.getPitch().toFixed(3),
    map.getBearing().toFixed(3),
    canvas.width,
    canvas.height,
  ].join('|');
}

function getScreenProjections(
  map: MapboxMap,
  points: Array<{ lat: number; lon: number }>,
): ScreenProjectionCache | null {
  let key: string;
  let bounds;
  try {
    key = cameraKey(map);
    bounds = map.getBounds();
  } catch {
    return null;
  }
  if (!bounds) return null;

  const now = performance.now();
  const cached = screenProjectionCache.get(points);
  if (
    cached
    && cached.key === key
    && cached.xs.length === points.length
    && now - cached.builtAt < SCREEN_PROJECTION_CACHE_TTL_MS
  ) {
    return cached;
  }

  const marginLon = Math.max(0.01, (bounds.getEast() - bounds.getWest()) * 0.15);
  const marginLat = Math.max(0.01, (bounds.getNorth() - bounds.getSouth()) * 0.15);
  const west = bounds.getWest() - marginLon;
  const east = bounds.getEast() + marginLon;
  const south = bounds.getSouth() - marginLat;
  const north = bounds.getNorth() + marginLat;

  const xs = new Float64Array(points.length).fill(Number.NaN);
  const ys = new Float64Array(points.length).fill(Number.NaN);
  const inView = (p: { lat: number; lon: number }) =>
    p.lon >= west && p.lon <= east && p.lat >= south && p.lat <= north;

  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    // Un point hors vue reste utile s'il borde un segment qui traverse l'écran.
    const needed = inView(p)
      || (i > 0 && inView(points[i - 1]!))
      || (i + 1 < points.length && inView(points[i + 1]!));
    if (!needed) continue;
    try {
      const s = map.project([p.lon, p.lat]);
      xs[i] = s.x;
      ys[i] = s.y;
    } catch {
      /* ignore projection error on out-of-world points */
    }
  }

  const next = { key, builtAt: now, xs, ys };
  screenProjectionCache.set(points, next);
  return next;
}

export function findContinuousRouteProjection(
  map: MapboxMap,
  points: Array<{ lat: number; lon: number }>,
  screenX: number,
  screenY: number,
  tolerancePx: number = MAX_ROUTE_DRAG_CLICK_DISTANCE_PX,
): ContinuousRouteProjection | null {
  if (points.length < 2) return null;

  const projections = getScreenProjections(map, points);
  if (!projections) return null;
  const { xs, ys } = projections;

  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestSegment = 0;
  let bestT = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    if (Number.isNaN(x0) || Number.isNaN(x1)) continue;

    const projection = projectPointToSegment(screenX, screenY, x0, ys[i]!, x1, ys[i + 1]!);
    if (projection.distanceSq < bestDistanceSq) {
      bestDistanceSq = projection.distanceSq;
      bestSegment = i;
      bestT = projection.t;
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
