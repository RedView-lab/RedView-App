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
 */

interface RouteDragWaypointContextValue {
  /**
   * Always false for now — kept on the interface so consumers can later read
   * the live drag state without a breaking change. The interaction itself is
   * fully driven by the provider's effects and refs.
   */
  dragging: boolean;
}

const RouteDragWaypointContext = createContext<RouteDragWaypointContextValue | null>(null);

/** Stable default value (dragging is ref-driven and not yet exposed). */
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

  // The session lives in a ref so the canvas listeners (attached once) can read
  // and mutate it without becoming stale closures.
  const sessionRef = useRef<DragSession | null>(null);
  const overRouteRef = useRef(false);

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

  const clearPreview = useCallback((target: MapboxMap) => {
    clearRouteHoverPreview(target);
  }, []);

  const commitDrag = useCallback(
    (dropLng: number, dropLat: number) => {
      if (!store || !activeItinerary || !routePoints) return;
      const session = sessionRef.current;
      if (!session) return;

      store.updateItinerary(activeItinerary.id, (it) => {
        if (it.gpxRoute?.source !== 'brouter' || it.gpxRoute.points.length < 2) return;
        const result = insertWaypointAtRoutePosition(
          it.timeline,
          it.gpxRoute.points,
          session.anchor,
          { lat: dropLat, lon: dropLng },
        );
        if (!result) return;
        it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, result.newRowId);
        delete it.pendingTraceExtension;
        delete it.routeAudit;
        it.prediction = null;
      });
    },
    [activeItinerary, routePoints, store],
  );

  useEffect(() => {
    if (!enabled || !map || !routePoints) {
      sessionRef.current = null;
      overRouteRef.current = false;
      return;
    }

    const canvas = map.getCanvas();
    let rafId: number | null = null;
    let pendingMove: { x: number; y: number; lng: number; lat: number } | null = null;

    const applyCursor = (cursor: string) => {
      canvas.style.cursor = cursor;
    };

    const isOverRoute = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const projection = findSplitProjectionForMapHover(
        map,
        routePoints,
        clientX - rect.left,
        clientY - rect.top,
      );
      return projection?.withinTolerance ?? false;
    };

    const flushMove = () => {
      rafId = null;
      const move = pendingMove;
      pendingMove = null;
      if (!move || !sessionRef.current) return;
      // The drag marker follows the cursor verbatim — BRouter snaps it to the
      // nearest road only on commit, so the preview shows the raw drop target.
      setRouteHoverPreview(map, { lon: move.lng, lat: move.lat });
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (sessionRef.current) return;
      if (!isOverRoute(event.clientX, event.clientY)) return;

      const lngLat = map.unproject([event.clientX, event.clientY] as [number, number]);
      const anchor = projectClickOntoRoute(routePoints, lngLat.lng, lngLat.lat);
      if (!anchor) return;

      sessionRef.current = { anchor };
      // Suppress native pan so the drag moves the waypoint, not the map.
      map.dragPan.disable();
      applyCursor('grabbing');
      setRouteHoverPreview(map, { lon: anchor.lon, lat: anchor.lat });
      event.preventDefault();
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (sessionRef.current) {
        const lngLat = map.unproject([event.clientX, event.clientY] as [number, number]);
        pendingMove = { x: event.clientX, y: event.clientY, lng: lngLat.lng, lat: lngLat.lat };
        if (rafId === null) rafId = window.requestAnimationFrame(flushMove);
        return;
      }

      // Idle hover: toggle the "grab" affordance when entering/leaving the trace.
      const over = isOverRoute(event.clientX, event.clientY);
      if (over !== overRouteRef.current) {
        overRouteRef.current = over;
        applyCursor(over ? 'grab' : '');
      }
    };

    const endDrag = (commit: boolean, event?: MouseEvent) => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingMove = null;

      if (commit && event) {
        const lngLat = map.unproject([event.clientX, event.clientY] as [number, number]);
        commitDrag(lngLat.lng, lngLat.lat);
      }

      map.dragPan.enable();
      applyCursor(overRouteRef.current ? 'grab' : '');
      clearPreview(map);
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      endDrag(true, event);
    };

    const handleMouseLeave = () => {
      overRouteRef.current = false;
      endDrag(false);
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!sessionRef.current) return;
      event.preventDefault();
      endDrag(false);
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('contextmenu', handleContextMenu);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('contextmenu', handleContextMenu);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingMove = null;
      sessionRef.current = null;
      overRouteRef.current = false;
      try {
        map.dragPan.enable();
      } catch {
        /* noop */
      }
      applyCursor('');
      clearPreview(map);
    };
  }, [clearPreview, commitDrag, enabled, map, routePoints]);

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
