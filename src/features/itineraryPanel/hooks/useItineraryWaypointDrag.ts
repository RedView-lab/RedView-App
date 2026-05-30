import { useEffect, useRef } from 'react';
import type {
  Map as MapboxMap,
  MapMouseEvent,
  MapTouchEvent,
  GeoJSONFeature,
  Point,
} from 'mapbox-gl';
import {
  ENDPOINT_HANDLE_HIT_LAYER_ID,
  ENDPOINT_LAYER_ID,
  clearWaypointDragConnector,
  collectRouteEndpoints,
  setRouteEndpoints,
  setWaypointDragConnector,
} from '../lib/route-layer';
import type { ItineraryProject, TimelineItem } from '../types';

type ActiveItinerary = ItineraryProject['itineraries'][number];

interface UseItineraryWaypointDragArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  active: ActiveItinerary | null;
  /** Commit a drop: persist the new anchor position and trigger a local BRouter reroute. */
  onCommitMove: (anchorId: string, lat: number, lon: number) => void;
}

/** Cursors this hook owns; anything else means another map tool is armed. */
const OWN_CURSORS = new Set(['', 'grab', 'grabbing']);
/** Pixels the pointer must travel before a press is treated as a drag (vs a click). */
const DRAG_THRESHOLD_PX = 4;

interface DragState {
  anchorId: string;
  startX: number;
  startY: number;
  moved: boolean;
}

function isRoutableRow(
  row: TimelineItem | undefined | null,
): row is TimelineItem & { lat: number; lon: number } {
  return Boolean(
    row
    && (row.kind === 'start' || row.kind === 'waypoint' || row.kind === 'end')
    && row.lat != null
    && row.lon != null,
  );
}

/**
 * Makes the BRouter route endpoints (start, intermediate waypoints, end)
 * draggable on the map. Dropping a handle persists its new position and asks
 * the routing engine to recompute only the affected segment (the existing
 * `pendingRoutePatch` machinery), so neighbouring segments stay intact.
 */
export function useItineraryWaypointDrag({
  map,
  isMapLoaded,
  active,
  onCommitMove,
}: UseItineraryWaypointDragArgs): void {
  const activeRef = useRef<ActiveItinerary | null>(active);
  const onCommitRef = useRef(onCommitMove);

  useEffect(() => {
    activeRef.current = active;
    onCommitRef.current = onCommitMove;
  });

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const canvas = map.getCanvas();
    const dragRef: { current: DragState | null } = { current: null };

    const toolCursorActive = (): boolean => {
      const cursor = canvas.style.cursor;
      return cursor !== '' && !OWN_CURSORS.has(cursor);
    };

    const routableRows = (): Array<TimelineItem & { lat: number; lon: number }> => {
      const timeline = activeRef.current?.timeline ?? [];
      return timeline.filter(isRoutableRow);
    };

    const handleAnchorAtPoint = (point: Point): string | null => {
      const layers = [ENDPOINT_HANDLE_HIT_LAYER_ID, ENDPOINT_LAYER_ID].filter((id) => {
        try {
          return Boolean(map.getLayer(id));
        } catch {
          return false;
        }
      });
      if (layers.length === 0) return null;
      let features: GeoJSONFeature[] = [];
      try {
        features = map.queryRenderedFeatures(point, { layers });
      } catch {
        return null;
      }
      for (const feature of features) {
        const anchorId = feature.properties?.anchorId;
        if (typeof anchorId === 'string' && anchorId) return anchorId;
      }
      return null;
    };

    const renderDragPreview = (anchorId: string, lngLat: { lng: number; lat: number }): void => {
      const rows = routableRows();
      const focusIndex = rows.findIndex((row) => row.id === anchorId);
      if (focusIndex < 0) return;

      // Move the dragged handle live.
      const endpoints = collectRouteEndpoints(activeRef.current?.timeline ?? []).map((endpoint) =>
        endpoint.id === anchorId ? { ...endpoint, lon: lngLat.lng, lat: lngLat.lat } : endpoint,
      );
      setRouteEndpoints(map, endpoints);

      // Rubber-band: previous -> cursor -> next neighbour.
      const previous = rows[focusIndex - 1];
      const next = rows[focusIndex + 1];
      const connector: Array<[number, number]> = [];
      if (previous) connector.push([previous.lon, previous.lat]);
      connector.push([lngLat.lng, lngLat.lat]);
      if (next) connector.push([next.lon, next.lat]);
      setWaypointDragConnector(map, connector.length >= 2 ? connector : null);
    };

    const endDrag = (): void => {
      dragRef.current = null;
      clearWaypointDragConnector(map);
      try {
        map.dragPan.enable();
      } catch {
        /* noop */
      }
      canvas.style.cursor = '';
    };

    const beginDrag = (
      anchorId: string,
      point: Point,
    ): void => {
      dragRef.current = { anchorId, startX: point.x, startY: point.y, moved: false };
      try {
        map.dragPan.disable();
      } catch {
        /* noop */
      }
      canvas.style.cursor = 'grabbing';
    };

    const onPointerDown = (event: MapMouseEvent | MapTouchEvent): void => {
      if (dragRef.current) return;
      // Left mouse button only (touch has no button concept).
      if ('button' in event.originalEvent && event.originalEvent.button !== 0) return;
      // Skip multi-touch gestures (pinch / rotate).
      if ('touches' in event.originalEvent && event.originalEvent.touches.length > 1) return;
      if (toolCursorActive()) return;

      const rows = routableRows();
      if (rows.length < 2) return;

      const anchorId = handleAnchorAtPoint(event.point);
      if (!anchorId) return;

      event.preventDefault();
      beginDrag(anchorId, event.point);
    };

    const onPointerMove = (event: MapMouseEvent | MapTouchEvent): void => {
      const drag = dragRef.current;
      if (!drag) {
        // Hover affordance over a handle when no other tool is armed.
        if (toolCursorActive()) return;
        const overHandle = handleAnchorAtPoint(event.point) != null;
        if (overHandle) canvas.style.cursor = 'grab';
        else if (canvas.style.cursor === 'grab') canvas.style.cursor = '';
        return;
      }

      if (!drag.moved) {
        const dx = event.point.x - drag.startX;
        const dy = event.point.y - drag.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
      }

      event.preventDefault();
      renderDragPreview(drag.anchorId, event.lngLat);
    };

    const onPointerUp = (event: MapMouseEvent | MapTouchEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;

      const { anchorId, moved } = drag;
      const lngLat = event.lngLat;
      endDrag();

      // A press without real movement is a click, not a drag: leave the route alone.
      if (moved && lngLat) {
        onCommitRef.current(anchorId, lngLat.lat, lngLat.lng);
      }
    };

    map.on('mousedown', onPointerDown);
    map.on('mousemove', onPointerMove);
    map.on('mouseup', onPointerUp);
    map.on('touchstart', onPointerDown);
    map.on('touchmove', onPointerMove);
    map.on('touchend', onPointerUp);

    return () => {
      map.off('mousedown', onPointerDown);
      map.off('mousemove', onPointerMove);
      map.off('mouseup', onPointerUp);
      map.off('touchstart', onPointerDown);
      map.off('touchmove', onPointerMove);
      map.off('touchend', onPointerUp);
      if (dragRef.current) endDrag();
    };
  }, [map, isMapLoaded]);
}
