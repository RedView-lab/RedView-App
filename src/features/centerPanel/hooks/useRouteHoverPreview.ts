import { useEffect, useRef } from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import {
  clearRouteHoverPreview,
  setRouteHoverPreview,
} from '@/features/itineraryPanel/lib/route-layer';
import { haversineRouteDistanceM } from '@/features/itineraryPanel/lib/routes';
import {
  findSplitProjectionForMapHover,
  type RouteSnapPoint,
} from '../routeSplit/routeSnap';

/**
 * Hover-preview marker shared by the central-panel tools.
 *
 * While a tool is armed this attaches a `mousemove` listener that renders a
 * single point marker over the route, showing where the next click will land:
 *
 *  - **Split mode** (`snap` provided): the marker snaps to the nearest route
 *    vertex. Within the click tolerance it's full-strength; outside it the
 *    marker dims to signal "a click here does nothing" while still tracking
 *    the cursor.
 *  - **Trace mode** (no `snap`): the marker follows the cursor verbatim, never
 *    dimmed, since every position is a valid click target.
 *
 * Performance follows the established chart-hover pattern (AnalysisFlyoverContext):
 * `mousemove` only schedules a `requestAnimationFrame`, and writes are skipped
 * when the marker moved less than {@link MIN_MOVE_M} since the last update.
 */

/** Skip setData when the marker moved less than this since the last write. */
const MIN_MOVE_M = 8;

export interface UseRouteHoverPreviewArgs {
  map: MapboxMap | null;
  armed: boolean;
  /** Marker fill color (route color). Falls back to the layer default. */
  color?: string;
  /**
   * Route vertices to snap to. Omit / null for free-follow (trace) mode;
   * provide for snap-to-trace (split) mode.
   */
  snapRoutePoints?: RouteSnapPoint[] | null;
}

export function useRouteHoverPreview({
  map,
  armed,
  color,
  snapRoutePoints,
}: UseRouteHoverPreviewArgs): void {
  const lastMarkerRef = useRef<{ lon: number; lat: number; dimmed: boolean } | null>(null);
  const pendingEventRef = useRef<MapMouseEvent | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!armed || !map) {
      lastMarkerRef.current = null;
      return;
    }

    const scheduleSync = (event: MapMouseEvent) => {
      pendingEventRef.current = event;
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const pending = pendingEventRef.current;
        pendingEventRef.current = null;
        if (!pending) return;
        applyPreview(pending);
      });
    };

    const applyPreview = (event: MapMouseEvent) => {
      let next: { lon: number; lat: number; dimmed: boolean };

      if (snapRoutePoints && snapRoutePoints.length >= 2) {
        const projection = findSplitProjectionForMapHover(
          map,
          snapRoutePoints,
          event.point.x,
          event.point.y,
        );
        if (!projection) return;
        next = {
          lon: projection.snapped.lon,
          lat: projection.snapped.lat,
          dimmed: !projection.withinTolerance,
        };
      } else {
        next = {
          lon: event.lngLat.lng,
          lat: event.lngLat.lat,
          dimmed: false,
        };
      }

      const previous = lastMarkerRef.current;
      if (
        previous
        && previous.dimmed === next.dimmed
        && haversineRouteDistanceM(previous, next) <= MIN_MOVE_M
      ) {
        return;
      }

      lastMarkerRef.current = next;
      setRouteHoverPreview(map, { ...next, color });
    };

    const handleMouseLeave = () => {
      pendingEventRef.current = null;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastMarkerRef.current = null;
      clearRouteHoverPreview(map);
    };

    map.on('mousemove', scheduleSync);
    map.on('mouseleave', handleMouseLeave);
    // Clear on the first move so a stale marker from a previous arming can't
    // linger before the cursor actually moves.
    clearRouteHoverPreview(map);

    return () => {
      map.off('mousemove', scheduleSync);
      map.off('mouseleave', handleMouseLeave);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingEventRef.current = null;
      lastMarkerRef.current = null;
      clearRouteHoverPreview(map);
    };
  }, [armed, map, color, snapRoutePoints]);
}
