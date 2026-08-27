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

/** Minimum pointer movement (in screen pixels) before a press is treated as a drag. */
const DRAG_THRESHOLD_PX = 6;
/** Proximity radius to look for a nearby POI marker when a simple click occurs near one. */
const POI_CLICK_PROXIMITY_PX = 26;

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
  startX: number;
  startY: number;
  isDragging: boolean;
}

function findNearbyPoiMarker(clientX: number, clientY: number, maxDistancePx = POI_CLICK_PROXIMITY_PX): HTMLElement | null {
  const direct = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.rv-poi-marker, .mapboxgl-marker');
  if (direct) return direct;

  const markers = document.querySelectorAll<HTMLElement>('.rv-poi-marker');
  let closest: HTMLElement | null = null;
  let minDist = maxDistancePx;

  for (const el of markers) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(clientX - cx, clientY - cy);
    if (dist < minDist) {
      minDist = dist;
      closest = el;
    }
  }

  return closest;
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
      setRouteHoverPreview(map, {
        lon: next.lng,
        lat: next.lat,
        color: routeColorRef.current,
      });
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
      const session = sessionRef.current;
      if (!session) return;

      const dist = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);

      if (!session.isDragging) {
        if (dist < DRAG_THRESHOLD_PX) return;
        session.isDragging = true;
        dragWasActiveRef.current = true;
        map.dragPan.disable();
        applyCursor('grabbing');
        setRouteHoverPreview(map, {
          lon: session.anchor.lon,
          lat: session.anchor.lat,
          color: routeColorRef.current,
        });
      }

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

      if (session.isDragging) {
        // Legitimate drag gesture: commit new waypoint.
        const lngLat = unprojectClient(event.clientX, event.clientY);
        commitDrag(session.anchor.lat, session.anchor.lon, lngLat.lng, lngLat.lat);
      } else {
        // Simple click without drag movement: DO NOT alter route.
        // If a POI marker was targeted or nearby, trigger its click so the popup opens.
        const nearbyPoi = findNearbyPoiMarker(event.clientX, event.clientY, POI_CLICK_PROXIMITY_PX);
        if (nearbyPoi) {
          nearbyPoi.click();
        }
      }

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
     * Capture-phase mousedown on the canvas container.
     */
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (sessionRef.current) return;

      // 1. If clicking directly on a POI marker, popup, or any interactive control, let it handle the click natively.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        target.closest(
          '.rv-poi-marker, .mapboxgl-marker, .mapboxgl-popup, .mapboxgl-popup-content, button, a, [role="button"], input, select, textarea',
        )
      ) {
        return;
      }

      const routePts = routePointsRef.current;
      if (!routePts || routePts.length < 2) return;

      const rect = canvas.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const clickY = event.clientY - rect.top;

      const projection = findSplitProjectionForMapHover(
        map,
        routePts,
        clickX,
        clickY,
      );
      if (!projection?.withinTolerance) return;

      const anchor = projectClickOntoRoute(routePts, projection.snapped.lon, projection.snapped.lat);
      if (!anchor) return;

      // Prevent Mapbox dragPan from stealing pointer before we know if it's a drag or click.
      event.stopPropagation();
      event.preventDefault();

      sessionRef.current = {
        anchor,
        startX: event.clientX,
        startY: event.clientY,
        isDragging: false,
      };

      window.addEventListener('mousemove', handleWindowMouseMove);
      window.addEventListener('mouseup', handleWindowMouseUp);
    };

    const handleHoverMouseMove = (event: MouseEvent) => {
      if (sessionRef.current?.isDragging) return;

      // If hovering over a POI marker or UI control, clear the route grab cursor.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        target.closest(
          '.rv-poi-marker, .mapboxgl-marker, .mapboxgl-popup, button, a, [role="button"]',
        )
      ) {
        if (overRouteRef.current) {
          overRouteRef.current = false;
          applyCursor('');
        }
        return;
      }

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
