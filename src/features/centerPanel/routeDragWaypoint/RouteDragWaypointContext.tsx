import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
import { getMapScreenPoint, unprojectClientPoint } from '@/features/map3d/lib/mapPointer';
import {
  clearRouteHoverPreview,
  setRouteHoverPreview,
} from '@/features/itineraryPanel/lib/route-layer';
import {
  buildPendingRoutePatchForEditedRow,
  insertWaypointAtRoutePosition,
} from '@/features/itineraryPanel/components/ItineraryPanelContainer/timelineMutations';
import { addItineraryVariantInPlace } from '@/features/itineraryPanel/lib/project';
import { reverseGeocodeSettlement } from '@/features/itineraryPanel/lib/geocoding';
import { translateAppText } from '@/shared/i18n';
import { isVariantModifierPressed } from '@/shared/lib/platform';
import { useRouteSplitToolOptional } from '../routeSplit';
import { useTraceToolOptional } from '../tracer';
import { TRACE_CURSOR } from '../tracer/TraceToolContext';
import { useRouteMergeToolOptional } from '../routeMerge';
import { useForbiddenZoneToolOptional } from '../forbiddenZones';
import {
  findContinuousRouteProjection,
  isClickNearExistingTimelinePoint,
  MAX_ROUTE_DRAG_CLICK_DISTANCE_PX,
} from './routeDragWaypointSnap';

/** Minimum pointer movement (in screen pixels) before a press is treated as a drag. */
const DRAG_THRESHOLD_PX = 5;
/** Proximity radius to look for a nearby POI marker when a simple click occurs near one. */
const POI_CLICK_PROXIMITY_PX = 24;

interface RouteDragWaypointContextValue {
  /** True while a route point is actively being dragged. */
  dragging: boolean;
}

const RouteDragWaypointContext = createContext<RouteDragWaypointContextValue | null>(null);

interface RouteDragWaypointProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

interface DragSession {
  /** World-space coordinate on the trace where the grab started. */
  anchor: { lat: number; lon: number };
  startX: number;
  startY: number;
  isDragging: boolean;
}

function findNearbyPoiMarker(
  clientX: number,
  clientY: number,
  maxDistancePx = POI_CLICK_PROXIMITY_PX,
): HTMLElement | null {
  const direct = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>('.rv-poi-marker, .mapboxgl-marker');
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

  const isTraceMode = Boolean(traceTool?.armed);
  const otherBlockingToolArmed = Boolean(
    splitTool?.armed || forbiddenZoneTool?.armed || mergeTool?.armed,
  );

  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const routePoints = activeItinerary?.gpxRoute?.points ?? null;
  const hasRoute = (routePoints?.length ?? 0) >= 2;

  // Active in both classic mode and tracing mode, as long as a route exists and no blocking tool is armed.
  const enabled = Boolean(map) && hasRoute && !otherBlockingToolArmed;

  const [isDragging, setIsDragging] = useState(false);
  const sessionRef = useRef<DragSession | null>(null);
  const overRouteRef = useRef(false);

  const storeRef = useRef(store);
  const activeItineraryIdRef = useRef(activeItinerary?.id);
  const routePointsRef = useRef(routePoints);
  const routeColorRef = useRef(activeItinerary?.color);
  const routeTraceWidthRef = useRef(store?.project.controlPanel?.routes?.traceWidthPx ?? 8);
  const isTraceModeRef = useRef(isTraceMode);

  useEffect(() => {
    storeRef.current = store;
    activeItineraryIdRef.current = activeItinerary?.id;
    routePointsRef.current = routePoints;
    routeColorRef.current = activeItinerary?.color;
    routeTraceWidthRef.current = store?.project.controlPanel?.routes?.traceWidthPx ?? 8;
    isTraceModeRef.current = isTraceMode;
  });

  const commitDrag = useCallback(
    (
      anchorLat: number,
      anchorLon: number,
      dropLng: number,
      dropLat: number,
      asVariant: boolean = false,
    ) => {
      const currentStore = storeRef.current;
      const itineraryId = activeItineraryIdRef.current;
      if (!currentStore || !itineraryId) return;

      const variantBox: { current: { createdItineraryId: string; createdItineraryName: string } | null } = {
        current: null,
      };

      const committed = currentStore.commitTraceMutation(itineraryId, (draft) => {
        let targetItinerary = draft.itineraries.find((it) => it.id === itineraryId);
        if (!targetItinerary) return false;
        if (asVariant) {
          const created = addItineraryVariantInPlace(draft, itineraryId);
          if (!created) return false;
          const forked = draft.itineraries.find((it) => it.id === created.createdItineraryId);
          if (!forked) return false;
          variantBox.current = created;
          targetItinerary = forked;
        }

        const currentRoute = targetItinerary.gpxRoute;
        if (!currentRoute?.points || currentRoute.points.length < 2) {
          return false;
        }

        const result = insertWaypointAtRoutePosition(
          targetItinerary.timeline,
          currentRoute.points,
          { lat: anchorLat, lon: anchorLon },
          { lat: dropLat, lon: dropLng },
        );
        if (!result) return false;

        if (currentRoute.source === 'brouter') {
          targetItinerary.pendingRoutePatch = buildPendingRoutePatchForEditedRow(
            targetItinerary.timeline,
            result.newRowId,
          );
        }
        delete targetItinerary.pendingTraceExtension;
        delete targetItinerary.routeAudit;
        targetItinerary.prediction = null;
        return true;
      });

      if (!committed) return;

      // Asynchronously resolve settlement name for the newly placed waypoint
      const targetItId = variantBox.current?.createdItineraryId ?? itineraryId;
      void reverseGeocodeSettlement(dropLng, dropLat, { maxDistanceMeters: 1000 })
        .then((settlement) => {
          const name = settlement?.name?.trim();
          if (!name) return;
          currentStore.updateItinerary(targetItId, (it) => {
            const newlyAdded = it.timeline.find(
              (row) =>
                row.kind === 'waypoint' &&
                row.lat === dropLat &&
                row.lon === dropLng &&
                (row.label === translateAppText('Nouveau point') || row.label === 'Nouveau point'),
            );
            if (newlyAdded) {
              newlyAdded.label = name;
            }
          });
        })
        .catch(() => {
          /* keep default fallback label */
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
    let dragRafId: number | null = null;
    let hoverRafId: number | null = null;
    let pendingDragLngLat: { lng: number; lat: number } | null = null;
    let pendingHoverEvent: MouseEvent | null = null;

    const applyCursor = (cursor: string) => {
      canvas.style.cursor = cursor;
    };

    const applyDefaultCursor = () => {
      applyCursor(isTraceModeRef.current ? TRACE_CURSOR : '');
    };

    const reenableDragPan = () => {
      try {
        map.dragPan.enable();
      } catch {
        /* noop */
      }
    };

    const unprojectClient = (clientX: number, clientY: number) =>
      unprojectClientPoint(map, clientX, clientY);

    const getPreviewRadius = () => {
      const traceWidth = routeTraceWidthRef.current ?? 8;
      return Math.max(5.5, Math.min(10, traceWidth / 2 + 2.5));
    };

    const flushDragMove = () => {
      dragRafId = null;
      const next = pendingDragLngLat;
      pendingDragLngLat = null;
      if (!next) return;

      setRouteHoverPreview(map, {
        lon: next.lng,
        lat: next.lat,
        color: routeColorRef.current,
        radius: getPreviewRadius(),
      });
    };

    const resetAfterDrag = () => {
      setIsDragging(false);
      if (dragRafId !== null) {
        window.cancelAnimationFrame(dragRafId);
        dragRafId = null;
      }
      pendingDragLngLat = null;
      reenableDragPan();
      applyCursor(overRouteRef.current ? 'grab' : (isTraceModeRef.current ? TRACE_CURSOR : ''));
      if (!overRouteRef.current) {
        clearRouteHoverPreview(map);
      }
    };

    const cancelDrag = () => {
      if (!sessionRef.current) return;
      setIsDragging(false);
      window.removeEventListener('mousemove', handleWindowMouseMove, true);
      window.removeEventListener('mouseup', handleWindowMouseUp, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      sessionRef.current = null;
      resetAfterDrag();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && sessionRef.current) {
        cancelDrag();
      }
    };

    const handleWindowMouseMove = (event: MouseEvent) => {
      const session = sessionRef.current;
      if (!session) return;

      const dist = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);

      if (!session.isDragging) {
        if (dist < DRAG_THRESHOLD_PX) return;
        session.isDragging = true;
        setIsDragging(true);
        map.dragPan.disable();
        applyCursor('grabbing');
      }

      const lngLat = unprojectClient(event.clientX, event.clientY);
      pendingDragLngLat = { lng: lngLat.lng, lat: lngLat.lat };
      if (dragRafId === null) dragRafId = window.requestAnimationFrame(flushDragMove);
    };

    const handleWindowMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const session = sessionRef.current;
      if (!session) return;

      window.removeEventListener('mousemove', handleWindowMouseMove, true);
      window.removeEventListener('mouseup', handleWindowMouseUp, true);
      window.removeEventListener('keydown', handleKeyDown, true);

      sessionRef.current = null;
      const asVariant = isVariantModifierPressed(event);

      if (session.isDragging) {
        // Drag gesture: commit new waypoint at dropped location
        const lngLat = unprojectClient(event.clientX, event.clientY);
        commitDrag(session.anchor.lat, session.anchor.lon, lngLat.lng, lngLat.lat, asVariant);
      } else {
        // Simple click without drag movement
        const nearbyPoi = findNearbyPoiMarker(event.clientX, event.clientY, POI_CLICK_PROXIMITY_PX);
        if (nearbyPoi) {
          nearbyPoi.click();
        } else {
          // Add a waypoint at the exact clicked anchor location
          commitDrag(
            session.anchor.lat,
            session.anchor.lon,
            session.anchor.lon,
            session.anchor.lat,
            asVariant,
          );
        }
      }

      resetAfterDrag();
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (sessionRef.current) return;

      // 1. If clicking directly on a POI marker, checkpoint marker, popup, or interactive control, let it handle natively
      const target = event.target as HTMLElement | null;
      if (
        target &&
        target.closest(
          '.rv-poi-marker, .rv-checkpoint-marker, .mapboxgl-marker, .mapboxgl-popup, .mapboxgl-popup-content, button, a, [role="button"], input, select, textarea, [data-rv-trace-point], [data-trace-point]',
        )
      ) {
        return;
      }

      const routePts = routePointsRef.current;
      if (!routePts || routePts.length < 2) return;

      const screenPt = getMapScreenPoint(map, event.clientX, event.clientY);

      // Avoid creating duplicate waypoints right on top of existing timeline points (within 16px)
      const currentTimeline = storeRef.current?.project.itineraries.find(
        (it) => it.id === activeItineraryIdRef.current,
      )?.timeline;
      if (
        currentTimeline &&
        isClickNearExistingTimelinePoint(map, currentTimeline, screenPt.x, screenPt.y, 16)
      ) {
        return;
      }

      const projection = findContinuousRouteProjection(
        map,
        routePts,
        screenPt.x,
        screenPt.y,
        MAX_ROUTE_DRAG_CLICK_DISTANCE_PX,
      );
      if (!projection?.withinTolerance) return;

      const anchor = { lat: projection.snapped.lat, lon: projection.snapped.lon };

      // Prevent Mapbox dragPan & map click from stealing pointer before drag or click completes
      event.stopPropagation();
      event.preventDefault();

      sessionRef.current = {
        anchor,
        startX: event.clientX,
        startY: event.clientY,
        isDragging: false,
      };

      window.addEventListener('mousemove', handleWindowMouseMove, true);
      window.addEventListener('mouseup', handleWindowMouseUp, true);
      window.addEventListener('keydown', handleKeyDown, true);
    };

    const processHover = (event: MouseEvent) => {
      hoverRafId = null;
      if (sessionRef.current?.isDragging) return;

      const target = event.target as HTMLElement | null;
      if (
        target &&
        target.closest(
          '.rv-poi-marker, .rv-checkpoint-marker, .mapboxgl-marker, .mapboxgl-popup, button, a, [role="button"]',
        )
      ) {
        if (overRouteRef.current) {
          overRouteRef.current = false;
          applyDefaultCursor();
          clearRouteHoverPreview(map);
        }
        return;
      }

      const routePts = routePointsRef.current;
      if (!routePts || routePts.length < 2) {
        if (overRouteRef.current) {
          overRouteRef.current = false;
          applyDefaultCursor();
          clearRouteHoverPreview(map);
        }
        return;
      }

      const screenPt = getMapScreenPoint(map, event.clientX, event.clientY);

      const projection = findContinuousRouteProjection(
        map,
        routePts,
        screenPt.x,
        screenPt.y,
        MAX_ROUTE_DRAG_CLICK_DISTANCE_PX,
      );

      const over = projection?.withinTolerance ?? false;

      if (over && projection) {
        overRouteRef.current = true;
        applyCursor('grab');
        setRouteHoverPreview(map, {
          lon: projection.snapped.lon,
          lat: projection.snapped.lat,
          color: routeColorRef.current,
          radius: getPreviewRadius(),
        });
      } else {
        if (overRouteRef.current) {
          overRouteRef.current = false;
          applyDefaultCursor();
          clearRouteHoverPreview(map);
        }
      }
    };

    const handleHoverMouseMove = (event: MouseEvent) => {
      if (sessionRef.current?.isDragging) return;
      pendingHoverEvent = event;
      if (hoverRafId === null) {
        hoverRafId = window.requestAnimationFrame(() => {
          if (pendingHoverEvent) {
            processHover(pendingHoverEvent);
            pendingHoverEvent = null;
          }
        });
      }
    };

    const handleMouseLeave = () => {
      if (sessionRef.current) return;
      overRouteRef.current = false;
      applyDefaultCursor();
      clearRouteHoverPreview(map);
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!sessionRef.current) return;
      event.preventDefault();
      cancelDrag();
    };

    canvasContainer.addEventListener('mousedown', handleMouseDown, true);
    canvasContainer.addEventListener('mousemove', handleHoverMouseMove);
    canvasContainer.addEventListener('mouseleave', handleMouseLeave);
    canvasContainer.addEventListener('contextmenu', handleContextMenu);

    return () => {
      canvasContainer.removeEventListener('mousedown', handleMouseDown, true);
      canvasContainer.removeEventListener('mousemove', handleHoverMouseMove);
      canvasContainer.removeEventListener('mouseleave', handleMouseLeave);
      canvasContainer.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('mousemove', handleWindowMouseMove, true);
      window.removeEventListener('mouseup', handleWindowMouseUp, true);
      window.removeEventListener('keydown', handleKeyDown, true);

      if (dragRafId !== null) {
        window.cancelAnimationFrame(dragRafId);
        dragRafId = null;
      }
      if (hoverRafId !== null) {
        window.cancelAnimationFrame(hoverRafId);
        hoverRafId = null;
      }
      pendingDragLngLat = null;
      pendingHoverEvent = null;
      sessionRef.current = null;
      overRouteRef.current = false;
      reenableDragPan();
      applyDefaultCursor();
      clearRouteHoverPreview(map);
    };
  }, [commitDrag, enabled, map]);

  const value = useMemo<RouteDragWaypointContextValue>(
    () => ({ dragging: isDragging }),
    [isDragging],
  );

  return (
    <RouteDragWaypointContext.Provider value={value}>
      {children}
    </RouteDragWaypointContext.Provider>
  );
}

export function useRouteDragWaypointOptional(): RouteDragWaypointContextValue | null {
  return useContext(RouteDragWaypointContext);
}
