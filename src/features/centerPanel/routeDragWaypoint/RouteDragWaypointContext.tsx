import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
import {
  clearRouteHoverPreview,
  setRouteHoverPreview,
} from '@/features/itineraryPanel/lib/route-layer';
import { buildPendingRoutePatchForEditedRow, insertWaypointAtRoutePosition } from '@/features/itineraryPanel/components/ItineraryPanelContainer/timelineMutations';
import { useRouteSplitToolOptional } from '../routeSplit';
import { useTraceToolOptional } from '../tracer';
import { useRouteMergeToolOptional } from '../routeMerge';
import { useForbiddenZoneToolOptional } from '../forbiddenZones';
import {
  findSplitProjectionForMapHover,
  projectClickOntoRoute,
} from './routeDragWaypointSnap';

/**
 * Press-and-drag waypoint tool.
 *
 * While a Brouter trace is rendered and no other center-panel tool is armed,
 * the user can grab the trace with the left mouse button and drag it onto
 * another road. On release a new waypoint is inserted at the grabbed position
 * (in route order) and the local segment is rerouted through it via the
 * existing `pendingRoutePatch` pipeline.
 *
 * Unlike the trace / split / forbidden-zone tools this one is **not** armed:
 * it is ambient whenever a route is on the map, and only stands down while an
 * explicit tool is active so the two interaction modes never compete for the
 * same click.
 *
 * Implementation notes:
 *  - Uses Mapbox's own `mousedown`/`mousemove`/`mouseup` events (not raw
 *    `canvas.addEventListener`) so the handlers receive `.lngLat` / `.point`
 *    already resolved — no manual `unproject` maths — and fire even when the
 *    cursor leaves the canvas mid-drag (Mapbox tracks the pointer globally
 *    while a drag is in progress).
 *  - `map.dragPan.disable()` is called on the grab `mousedown` together with
 *    `preventDefault()` on the original event, so Mapbox's built-in pan never
 *    starts and the gesture is fully owned by the waypoint drag. `dragPan` is
 *    re-enabled on every exit path.
 */

interface RouteDragWaypointContextValue {
  /** Reserved for future consumers; the drag itself is fully effect-driven. */
  dragging: boolean;
}

const RouteDragWaypointContext = createContext<RouteDragWaypointContextValue | null>(null);

const ROUTE_DRAG_WAYPOINT_DEFAULT_VALUE: RouteDragWaypointContextValue = { dragging: false };

interface RouteDragWaypointProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

interface DragSession {
  /** World-space coordinate projected onto the trace where the grab started. */
  anchor: { lat: number; lon: number };
}

export function RouteDragWaypointProvider({ children, map }: RouteDragWaypointProviderProps) {
  const store = useProjectStoreOptional();
  const splitTool = useRouteSplitToolOptional();
  const traceTool = useTraceToolOptional();
  const mergeTool = useRouteMergeToolOptional();
  const forbiddenZoneTool = useForbiddenZoneToolOptional();

  // The session lives in a ref so the map listeners (attached once) can read
  // and mutate it without becoming stale closures.
  const sessionRef = useRef<DragSession | null>(null);
  const overRouteRef = useRef(false);
  const dragWasActiveRef = useRef(false);

  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const routePoints = activeItinerary?.gpxRoute?.source === 'brouter'
    ? activeItinerary.gpxRoute.points
    : null;
  const hasBrouterRoute = (routePoints?.length ?? 0) >= 2;

  // Any explicit tool armed → stand down entirely (neutral cursor, no drag).
  const otherToolArmed = Boolean(
    splitTool?.armed || traceTool?.armed || forbiddenZoneTool?.armed || mergeTool?.armed,
  );

  const enabled = Boolean(map) && hasBrouterRoute && !otherToolArmed;

  const commitDrag = useCallback(
    (anchorLat: number, anchorLon: number, dropLng: number, dropLat: number) => {
      if (!store || !activeItinerary) return;

      store.updateItinerary(activeItinerary.id, (it) => {
        if (it.gpxRoute?.source !== 'brouter' || it.gpxRoute.points.length < 2) return;
        const result = insertWaypointAtRoutePosition(
          it.timeline,
          it.gpxRoute.points,
          { lat: anchorLat, lon: anchorLon },
          { lat: dropLat, lon: dropLng },
        );
        if (!result) return;
        it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, result.newRowId);
        delete it.pendingTraceExtension;
        delete it.routeAudit;
        it.prediction = null;
      });
    },
    [activeItinerary, store],
  );

  useEffect(() => {
    if (!enabled || !map || !routePoints) {
      sessionRef.current = null;
      overRouteRef.current = false;
      return;
    }

    const canvas = map.getCanvas();
    let rafId: number | null = null;
    let pendingDragLngLat: { lng: number; lat: number } | null = null;

    const applyCursor = (cursor: string) => {
      canvas.style.cursor = cursor;
    };

    const reenableDragPan = () => {
      try {
        map.dragPan.enable();
      } catch {
        /* noop */
      }
    };

    const flushDragMove = () => {
      rafId = null;
      const next = pendingDragLngLat;
      pendingDragLngLat = null;
      if (!next) return;
      // The drag marker follows the cursor verbatim — BRouter snaps it to the
      // nearest road only on commit, so the preview shows the raw drop target.
      setRouteHoverPreview(map, { lon: next.lng, lat: next.lat });
    };

    const handleMouseDown = (event: MapMouseEvent) => {
      if (event.originalEvent.button !== 0) return;
      if (sessionRef.current) return;

      const projection = findSplitProjectionForMapHover(
        map,
        routePoints,
        event.point.x,
        event.point.y,
      );
      if (!projection?.withinTolerance) return;

      const anchor = projectClickOntoRoute(routePoints, event.lngLat.lng, event.lngLat.lat);
      if (!anchor) return;

      // Own the gesture: stop Mapbox from panning and swallow the default
      // action so the press is interpreted as a waypoint grab, not a map drag.
      event.originalEvent.preventDefault();
      map.dragPan.disable();

      sessionRef.current = { anchor };
      dragWasActiveRef.current = true;
      applyCursor('grabbing');
      setRouteHoverPreview(map, { lon: anchor.lon, lat: anchor.lat, color: activeItinerary?.color });
    };

    const handleMouseMove = (event: MapMouseEvent) => {
      const session = sessionRef.current;
      if (session) {
        pendingDragLngLat = { lng: event.lngLat.lng, lat: event.lngLat.lat };
        if (rafId === null) rafId = window.requestAnimationFrame(flushDragMove);
        return;
      }

      // Idle hover: toggle the "grab" affordance when entering/leaving the trace.
      const projection = findSplitProjectionForMapHover(
        map,
        routePoints,
        event.point.x,
        event.point.y,
      );
      const over = projection?.withinTolerance ?? false;
      if (over !== overRouteRef.current) {
        overRouteRef.current = over;
        applyCursor(over ? 'grab' : '');
      }
    };

    const handleMouseUp = (event: MapMouseEvent) => {
      if (event.originalEvent.button !== 0) return;
      const session = sessionRef.current;
      if (!session) return;

      sessionRef.current = null;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingDragLngLat = null;

      commitDrag(session.anchor.lat, session.anchor.lon, event.lngLat.lng, event.lngLat.lat);

      reenableDragPan();
      applyCursor(overRouteRef.current ? 'grab' : '');
      clearRouteHoverPreview(map);
    };

    const cancelDrag = () => {
      if (!sessionRef.current) return;
      sessionRef.current = null;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingDragLngLat = null;
      reenableDragPan();
      applyCursor(overRouteRef.current ? 'grab' : '');
      clearRouteHoverPreview(map);
    };

    const handleMouseLeave = () => {
      // Only cancel if we're not mid-drag — Mapbox keeps firing mousemove while
      // a drag is captured even outside the canvas, so a stray mouseleave must
      // not abort an ongoing grab.
      if (!sessionRef.current) {
        overRouteRef.current = false;
        applyCursor('');
      }
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      if (!sessionRef.current) return;
      event.preventDefault();
      cancelDrag();
    };

    map.on('mousedown', handleMouseDown);
    map.on('mousemove', handleMouseMove);
    map.on('mouseup', handleMouseUp);
    map.on('mouseleave', handleMouseLeave);
    map.on('contextmenu', handleContextMenu);

    return () => {
      map.off('mousedown', handleMouseDown);
      map.off('mousemove', handleMouseMove);
      map.off('mouseup', handleMouseUp);
      map.off('mouseleave', handleMouseLeave);
      map.off('contextmenu', handleContextMenu);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingDragLngLat = null;
      sessionRef.current = null;
      overRouteRef.current = false;
      reenableDragPan();
      applyCursor('');
      clearRouteHoverPreview(map);
      dragWasActiveRef.current = false;
    };
  }, [activeItinerary?.color, commitDrag, enabled, map, routePoints]);

  const value = ROUTE_DRAG_WAYPOINT_DEFAULT_VALUE;

  return (
    <RouteDragWaypointContext.Provider value={value}>
      {children}
    </RouteDragWaypointContext.Provider>
  );
}

export function useRouteDragWaypointOptional(): RouteDragWaypointContextValue | null {
  return useContext(RouteDragWaypointContext);
}
