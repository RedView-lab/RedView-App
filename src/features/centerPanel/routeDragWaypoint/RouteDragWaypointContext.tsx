import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

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

  // The session lives in a ref so the canvas listeners (attached once) can read
  // and mutate it without becoming stale closures.
  const sessionRef = useRef<DragSession | null>(null);
  const overRouteRef = useRef(false);
  const dragWasActiveRef = useRef(false);

  // Live values read inside the (stable) DOM handlers. Kept in refs and updated
  // via an effect so the listeners never go stale, BUT the attach/detach effect
  // doesn't re-run on every store mutation — otherwise an in-progress grab is
  // torn down the moment the project object changes identity.
  const storeRef = useRef(store);
  const activeItineraryIdRef = useRef(activeItinerary?.id);
  const routePointsRef = useRef(routePoints);
  const routeColorRef = useRef(activeItinerary?.color);
  useEffect(() => {
    storeRef.current = store;
    activeItineraryIdRef.current = activeItinerary?.id;
    routePointsRef.current = routePoints;
    routeColorRef.current = activeItinerary?.color;
  });

  const commitDrag = useCallback(
    (anchorLat: number, anchorLon: number, dropLng: number, dropLat: number) => {
      const currentStore = storeRef.current;
      const itineraryId = activeItineraryIdRef.current;
      if (!currentStore || !itineraryId) return;

      currentStore.updateItinerary(itineraryId, (it) => {
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
    [],
  );

  useEffect(() => {
    if (!enabled || !map) {
      sessionRef.current = null;
      overRouteRef.current = false;
      return;
    }

    const canvas = map.getCanvas();
    const canvasContainer = map.getCanvasContainer();
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

    /** Convert a viewport (clientX/Y) coordinate into an lng/lat. */
    const unprojectClient = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return map.unproject([clientX - rect.left, clientY - rect.top] as [number, number]);
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

    const resetAfterDrag = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingDragLngLat = null;
      reenableDragPan();
      applyCursor(overRouteRef.current ? 'grab' : '');
      clearRouteHoverPreview(map);
    };

    /**
     * Window-level move handler active only while a grab is in progress. Bound
     * on `mousedown` and removed on `mouseup`, so it never competes with idle
     * hover detection.
     */
    const handleWindowMouseMove = (event: MouseEvent) => {
      if (!sessionRef.current) return;
      const lngLat = unprojectClient(event.clientX, event.clientY);
      pendingDragLngLat = { lng: lngLat.lng, lat: lngLat.lat };
      if (rafId === null) rafId = window.requestAnimationFrame(flushDragMove);
    };

    const handleWindowMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const session = sessionRef.current;
      if (!session) return;

      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);

      sessionRef.current = null;
      const lngLat = unprojectClient(event.clientX, event.clientY);
      commitDrag(session.anchor.lat, session.anchor.lon, lngLat.lng, lngLat.lat);
      resetAfterDrag();
    };

    const cancelDrag = () => {
      if (!sessionRef.current) return;
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
      sessionRef.current = null;
      resetAfterDrag();
    };

    /**
     * Capture-phase mousedown on the canvas container. By stopping propagation
     * here Mapbox never receives the press, so it cannot start its own drag-pan
     * — no race, no immediate cancel. We then drive the rest of the gesture
     * from window-level listeners (so the cursor can leave the canvas mid-drag).
     */
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (sessionRef.current) return;

      const routePts = routePointsRef.current;
      if (!routePts || routePts.length < 2) return;

      const rect = canvas.getBoundingClientRect();
      const projection = findSplitProjectionForMapHover(
        map,
        routePts,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      if (!projection?.withinTolerance) return;

      const anchor = projectClickOntoRoute(routePts, projection.snapped.lon, projection.snapped.lat);
      if (!anchor) return;

      // Swallow the event before Mapbox's own handler sees it. This is the key
      // fix: previously Mapbox started a pan on the same mousedown and fired a
      // mouseup immediately, cancelling the grab within a frame.
      event.stopPropagation();
      event.preventDefault();
      map.dragPan.disable();

      sessionRef.current = { anchor };
      dragWasActiveRef.current = true;
      applyCursor('grabbing');
      setRouteHoverPreview(map, {
        lon: anchor.lon,
        lat: anchor.lat,
        color: routeColorRef.current,
      });

      window.addEventListener('mousemove', handleWindowMouseMove);
      window.addEventListener('mouseup', handleWindowMouseUp);
    };

    const handleHoverMouseMove = (event: MouseEvent) => {
      if (sessionRef.current) return;
      const routePts = routePointsRef.current;
      if (!routePts || routePts.length < 2) return;
      const rect = canvas.getBoundingClientRect();
      const projection = findSplitProjectionForMapHover(
        map,
        routePts,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      const over = projection?.withinTolerance ?? false;
      if (over !== overRouteRef.current) {
        overRouteRef.current = over;
        applyCursor(over ? 'grab' : '');
      }
    };

    const handleMouseLeave = () => {
      if (sessionRef.current) return;
      overRouteRef.current = false;
      applyCursor('');
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!sessionRef.current) return;
      event.preventDefault();
      cancelDrag();
    };

    // Capture phase so we run *before* Mapbox's drag-pan handler.
    canvasContainer.addEventListener('mousedown', handleMouseDown, true);
    canvas.addEventListener('mousemove', handleHoverMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('contextmenu', handleContextMenu);

    return () => {
      canvasContainer.removeEventListener('mousedown', handleMouseDown, true);
      canvas.removeEventListener('mousemove', handleHoverMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
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
    // Listeners attach once per map/enablement change. Live project data is
    // read from refs inside the handlers, so a store mutation never tears down
    // an in-progress grab.
  }, [commitDrag, enabled, map]);

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
