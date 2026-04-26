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
import type { Map as MapboxMap, MapLayerMouseEvent, MapMouseEvent } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
import {
  clearForbiddenZoneDraft,
  FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID,
  setForbiddenZoneDraft,
} from '@/features/itineraryPanel/lib/route-layer';

const FORBIDDEN_CURSOR = 'url("/svgv2/icone/slash-octagon.svg") 8 8, not-allowed';
const FORBIDDEN_VERTEX_CURSOR = 'grab';
const FORBIDDEN_VERTEX_DRAG_CURSOR = 'grabbing';
const POINT_EPSILON = 1e-6;
const MAX_SEGMENT_INSERT_DISTANCE_PX = 42;

interface ForbiddenZoneToolContextValue {
  armed: boolean;
  canEdit: boolean;
  canUndoDraft: boolean;
  canRedoDraft: boolean;
  statusMessage: string | null;
  toggle: () => void;
  deactivate: () => void;
  undoDraft: () => void;
  redoDraft: () => void;
}

const ForbiddenZoneToolContext = createContext<ForbiddenZoneToolContextValue | null>(null);

interface ForbiddenZoneToolProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

export function ForbiddenZoneToolProvider({ children, map }: ForbiddenZoneToolProviderProps) {
  const store = useProjectStoreOptional();
  const [armed, setArmed] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [draftPoints, setDraftPoints] = useState<Array<{ lat: number; lon: number }>>([]);
  const [draftFuture, setDraftFuture] = useState<Array<Array<{ lat: number; lon: number }>>>([]);
  const draftPointsRef = useRef(draftPoints);
  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const canEdit = Boolean(store && activeItinerary);
  const canUndoDraft = draftPoints.length > 0;
  const canRedoDraft = draftFuture.length > 0;

  const resetDraft = useCallback(() => {
    setDraftPoints([]);
    setDraftFuture([]);
    if (map) clearForbiddenZoneDraft(map);
  }, [map]);

  const updateDraftStatus = useCallback((points: Array<{ lat: number; lon: number }>) => {
    if (points.length <= 0) {
      setStatusMessage('Cliquez pour poser la zone, double-cliquez pour fermer (3 points minimum)');
      return;
    }
    setStatusMessage(
      points.length >= 3
        ? 'Double-cliquez pour fermer la zone interdite'
        : `Zone interdite: ${points.length}/3 points minimum`,
    );
  }, []);

  const deactivate = useCallback(() => {
    setArmed(false);
    setStatusMessage(null);
    resetDraft();
  }, [resetDraft]);

  const toggle = useCallback(() => {
    if (!canEdit) return;
    setArmed((current) => {
      const next = !current;
      if (!next) {
        setStatusMessage(null);
        setDraftPoints([]);
        setDraftFuture([]);
        if (map) clearForbiddenZoneDraft(map);
        return next;
      }
      setStatusMessage('Cliquez pour poser la zone, double-cliquez pour fermer (3 points minimum)');
      return next;
    });
  }, [canEdit, map]);

  const undoDraft = useCallback(() => {
    setDraftPoints((current) => {
      if (current.length === 0) return current;
      const next = current.slice(0, -1);
      setDraftFuture((future) => [current, ...future]);
      updateDraftStatus(next);
      return next;
    });
  }, [updateDraftStatus]);

  const redoDraft = useCallback(() => {
    setDraftFuture((future) => {
      const [nextPoints, ...rest] = future;
      if (!nextPoints) return future;
      setDraftPoints(nextPoints);
      updateDraftStatus(nextPoints);
      return rest;
    });
  }, [updateDraftStatus]);

  useEffect(() => {
    draftPointsRef.current = draftPoints;
  }, [draftPoints]);

  useEffect(() => {
    if (canEdit) return;
    deactivate();
  }, [canEdit, deactivate]);

  useEffect(() => {
    if (!map || !armed) return;
    if (draftPoints.length > 0) setForbiddenZoneDraft(map, draftPoints);
    else clearForbiddenZoneDraft(map);

    const restoreDraft = () => {
      if (draftPoints.length > 0) setForbiddenZoneDraft(map, draftPoints);
      else clearForbiddenZoneDraft(map);
    };

    map.on('style.load', restoreDraft);
    return () => {
      map.off('style.load', restoreDraft);
    };
  }, [armed, draftPoints, map]);

  useEffect(() => {
    if (!armed || !map || !store || !activeItinerary) return;

    const canvas = map.getCanvas();
    const wasDoubleClickZoomEnabled = map.doubleClickZoom.isEnabled();
    const wasDragPanEnabled = map.dragPan.isEnabled();
    const wasDragRotateEnabled = map.dragRotate.isEnabled();

    if (wasDoubleClickZoomEnabled) map.doubleClickZoom.disable();
    if (wasDragPanEnabled) map.dragPan.disable();
    if (wasDragRotateEnabled) map.dragRotate.disable();

    type DragState = { kind: 'idle' } | { kind: 'vertex'; pointIndex: number };
    let dragState: DragState = { kind: 'idle' };
    let hoverState: 'none' | 'vertex' | 'segment' = 'none';
    let suppressNextClick = false;

    const refreshCursor = () => {
      if (dragState.kind === 'vertex') {
        canvas.style.cursor = FORBIDDEN_VERTEX_DRAG_CURSOR;
        return;
      }
      if (hoverState === 'vertex') {
        canvas.style.cursor = FORBIDDEN_VERTEX_CURSOR;
        return;
      }
      canvas.style.cursor = FORBIDDEN_CURSOR;
    };

    refreshCursor();

    const handleVertexEnter = () => {
      hoverState = 'vertex';
      refreshCursor();
    };
    const handleVertexLeave = () => {
      if (hoverState === 'vertex') hoverState = 'none';
      refreshCursor();
    };
    const handleSegmentEnter = () => {
      if (hoverState !== 'vertex') hoverState = 'segment';
      refreshCursor();
    };
    const handleSegmentLeave = () => {
      if (hoverState === 'segment') hoverState = 'none';
      refreshCursor();
    };

    const finalizeIfDoubleClick = (
      nextPoints: Array<{ lat: number; lon: number }>,
      clickCount: number,
    ): boolean => {
      if (clickCount < 2 || nextPoints.length < 3) return false;
      const created = store.addForbiddenZone(activeItinerary.id, nextPoints);
      if (!created) return false;
      setArmed(false);
      setDraftPoints([]);
      draftPointsRef.current = [];
      setStatusMessage('Zone interdite enregistrée');
      clearForbiddenZoneDraft(map);
      canvas.style.cursor = '';
      return true;
    };

    const commitDraftPoints = (nextPoints: Array<{ lat: number; lon: number }>) => {
      draftPointsRef.current = nextPoints;
      setDraftPoints(nextPoints);
      setDraftFuture([]);
      updateDraftStatus(nextPoints);
    };

    const handleVertexMouseDown = (event: MapLayerMouseEvent) => {
      const pointIndex = readIndexFromLayerEvent(event, 'index');
      if (pointIndex == null) return;
      const original = event.originalEvent;
      if (original instanceof MouseEvent && original.button !== 0) return;

      event.preventDefault();
      original?.preventDefault?.();
      original?.stopPropagation?.();

      dragState = { kind: 'vertex', pointIndex };
      suppressNextClick = true;
      refreshCursor();
      setStatusMessage('Glissez le sommet pour le déplacer');

      window.addEventListener('mousemove', handleWindowMouseMove);
      window.addEventListener('mouseup', handleWindowMouseUp, { once: true });
    };

    const handleWindowMouseMove = (event: MouseEvent) => {
      if (dragState.kind !== 'vertex') return;
      const pointIndex = dragState.pointIndex;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const lngLat = map.unproject([x, y]);
      const currentPoints = draftPointsRef.current;
      const target = currentPoints[pointIndex];
      if (!target) return;
      if (
        Math.abs(target.lat - lngLat.lat) < POINT_EPSILON &&
        Math.abs(target.lon - lngLat.lng) < POINT_EPSILON
      ) {
        return;
      }
      const next = currentPoints.map((point, index) =>
        index === pointIndex ? { lat: lngLat.lat, lon: lngLat.lng } : point,
      );
      draftPointsRef.current = next;
      setDraftPoints(next);
      setDraftFuture([]);
    };

    const handleWindowMouseUp = () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      if (dragState.kind === 'vertex') {
        dragState = { kind: 'idle' };
        updateDraftStatus(draftPointsRef.current);
        refreshCursor();
      }
    };

    const handleSegmentClick = (event: MapLayerMouseEvent) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const edgeIndex = readIndexFromLayerEvent(event, 'edgeIndex');
      if (edgeIndex == null) return;
      const currentPoints = draftPointsRef.current;
      const start = currentPoints[edgeIndex];
      const end = currentPoints[(edgeIndex + 1) % currentPoints.length];
      if (!start || !end) return;

      const startScreen = map.project([start.lon, start.lat]);
      const endScreen = map.project([end.lon, end.lat]);
      const projection = projectPointToSegment(
        event.point.x,
        event.point.y,
        startScreen.x,
        startScreen.y,
        endScreen.x,
        endScreen.y,
      );
      const projectedLngLat = map.unproject([projection.x, projection.y]);
      const insertedPoint = { lat: projectedLngLat.lat, lon: projectedLngLat.lng };
      if (sameDraftPoint(start, insertedPoint) || sameDraftPoint(end, insertedPoint)) return;

      const insertAt = edgeIndex + 1;
      const nextPoints = [
        ...currentPoints.slice(0, insertAt),
        insertedPoint,
        ...currentPoints.slice(insertAt),
      ];

      const clickCount = event.originalEvent instanceof MouseEvent ? event.originalEvent.detail : 1;
      if (finalizeIfDoubleClick(nextPoints, clickCount)) return;

      suppressNextClick = true;
      commitDraftPoints(nextPoints);
    };

    const handleMapClick = (event: MapMouseEvent) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const currentPoints = draftPointsRef.current;
      const interiorInsert = currentPoints.length >= 3 && pointInDraftPolygon(
        { lat: event.lngLat.lat, lon: event.lngLat.lng },
        currentPoints,
      )
        ? insertDraftPointAtNearestSegment(map, currentPoints, event)
        : null;

      const nextPoints =
        interiorInsert ?? appendDraftPoint(currentPoints, { lat: event.lngLat.lat, lon: event.lngLat.lng });

      const clickCount = event.originalEvent instanceof MouseEvent ? event.originalEvent.detail : 1;
      if (finalizeIfDoubleClick(nextPoints, clickCount)) return;

      commitDraftPoints(nextPoints);
    };

    map.on('mouseenter', FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID, handleVertexEnter);
    map.on('mouseleave', FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID, handleVertexLeave);
    map.on('mouseenter', FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID, handleSegmentEnter);
    map.on('mouseleave', FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID, handleSegmentLeave);
    map.on('mousedown', FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID, handleVertexMouseDown);
    map.on('click', FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID, handleSegmentClick);
    map.on('click', handleMapClick);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
      map.off('mouseenter', FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID, handleVertexEnter);
      map.off('mouseleave', FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID, handleVertexLeave);
      map.off('mouseenter', FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID, handleSegmentEnter);
      map.off('mouseleave', FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID, handleSegmentLeave);
      map.off('mousedown', FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID, handleVertexMouseDown);
      map.off('click', FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID, handleSegmentClick);
      map.off('click', handleMapClick);
      if (wasDoubleClickZoomEnabled) map.doubleClickZoom.enable();
      if (wasDragPanEnabled) map.dragPan.enable();
      if (wasDragRotateEnabled) map.dragRotate.enable();
      canvas.style.cursor = '';
    };
  }, [activeItinerary, armed, map, store, updateDraftStatus]);

  const value = useMemo<ForbiddenZoneToolContextValue>(
    () => ({
      armed,
      canEdit,
      canUndoDraft,
      canRedoDraft,
      statusMessage,
      toggle,
      deactivate,
      undoDraft,
      redoDraft,
    }),
    [armed, canEdit, canRedoDraft, canUndoDraft, deactivate, redoDraft, statusMessage, toggle, undoDraft],
  );

  return (
    <ForbiddenZoneToolContext.Provider value={value}>
      {children}
    </ForbiddenZoneToolContext.Provider>
  );
}

export function useForbiddenZoneToolOptional(): ForbiddenZoneToolContextValue | null {
  return useContext(ForbiddenZoneToolContext);
}

function appendDraftPoint(
  points: Array<{ lat: number; lon: number }>,
  point: { lat: number; lon: number },
): Array<{ lat: number; lon: number }> {
  const last = points[points.length - 1];
  if (
    last &&
    Math.abs(last.lat - point.lat) <= POINT_EPSILON &&
    Math.abs(last.lon - point.lon) <= POINT_EPSILON
  ) {
    return points;
  }
  return [...points, point];
}

function insertDraftPointAtNearestSegment(
  map: MapboxMap,
  points: Array<{ lat: number; lon: number }>,
  event: MapMouseEvent,
): Array<{ lat: number; lon: number }> | null {
  if (points.length < 2) return null;

  const clickPoint = { lat: event.lngLat.lat, lon: event.lngLat.lng };
  const treatAsEdgeEdit =
    points.length >= 3 && pointInDraftPolygon(clickPoint, points);

  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestInsertIndex: number | null = null;
  let bestProjectedScreenPoint: { x: number; y: number } | null = null;
  const segmentCount = points.length >= 3 ? points.length : points.length - 1;

  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (!end) continue;

    const startScreen = map.project([start.lon, start.lat]);
    const endScreen = map.project([end.lon, end.lat]);
    const projection = projectPointToSegment(
      event.point.x,
      event.point.y,
      startScreen.x,
      startScreen.y,
      endScreen.x,
      endScreen.y,
    );
    if (projection.distanceSq >= bestDistanceSq) continue;
    bestDistanceSq = projection.distanceSq;
    bestInsertIndex = index === points.length - 1 ? points.length : index + 1;
    bestProjectedScreenPoint = { x: projection.x, y: projection.y };
  }

  if (
    bestInsertIndex == null ||
    !bestProjectedScreenPoint ||
    (!treatAsEdgeEdit && bestDistanceSq > MAX_SEGMENT_INSERT_DISTANCE_PX * MAX_SEGMENT_INSERT_DISTANCE_PX)
  ) {
    return null;
  }

  const projected = map.unproject([bestProjectedScreenPoint.x, bestProjectedScreenPoint.y]);
  const insertedPoint = { lat: projected.lat, lon: projected.lng };
  const previousPoint = points[(bestInsertIndex - 1 + points.length) % points.length];
  const nextPoint = points[bestInsertIndex % points.length];
  if (
    (previousPoint && sameDraftPoint(previousPoint, insertedPoint)) ||
    (nextPoint && sameDraftPoint(nextPoint, insertedPoint))
  ) {
    return null;
  }

  return [
    ...points.slice(0, bestInsertIndex),
    insertedPoint,
    ...points.slice(bestInsertIndex),
  ];
}

function sameDraftPoint(
  left: { lat: number; lon: number },
  right: { lat: number; lon: number },
): boolean {
  return (
    Math.abs(left.lat - right.lat) <= POINT_EPSILON &&
    Math.abs(left.lon - right.lon) <= POINT_EPSILON
  );
}

function readIndexFromLayerEvent(event: MapLayerMouseEvent, propertyName: string): number | null {
  for (const feature of event.features ?? []) {
    const indexValue = feature.properties?.[propertyName];
    const index = typeof indexValue === 'number' ? indexValue : Number(indexValue);
    if (!Number.isInteger(index) || index < 0) continue;
    return index;
  }

  return null;
}

function pointInDraftPolygon(
  point: { lat: number; lon: number },
  polygon: Array<{ lat: number; lon: number }>,
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects =
      (a.lat > point.lat) !== (b.lat > point.lat) &&
      point.lon < ((b.lon - a.lon) * (point.lat - a.lat)) / ((b.lat - a.lat) || Number.EPSILON) + a.lon;
    if (intersects) inside = !inside;
  }
  return inside;
}

function projectPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distanceSq: number; x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const segmentLengthSq = dx * dx + dy * dy;
  if (segmentLengthSq <= 1e-6) {
    return {
      distanceSq: (px - ax) * (px - ax) + (py - ay) * (py - ay),
      x: ax,
      y: ay,
    };
  }

  const rawT = ((px - ax) * dx + (py - ay) * dy) / segmentLengthSq;
  const t = Math.max(0, Math.min(1, rawT));
  const x = ax + dx * t;
  const y = ay + dy * t;
  return {
    distanceSq: (px - x) * (px - x) + (py - y) * (py - y),
    x,
    y,
  };
}