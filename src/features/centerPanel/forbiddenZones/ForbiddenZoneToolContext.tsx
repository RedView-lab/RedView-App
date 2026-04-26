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
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
import {
  clearForbiddenZoneDraft,
  FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID,
  setForbiddenZoneDraft,
} from '@/features/itineraryPanel/lib/route-layer';

const FORBIDDEN_CURSOR = 'crosshair';
const FORBIDDEN_SEGMENT_CURSOR = 'pointer';
const FORBIDDEN_VERTEX_CURSOR = 'grab';
const FORBIDDEN_VERTEX_DRAG_CURSOR = 'grabbing';
const HIT_QUERY_RADIUS_PX = 32;
const POINT_EPSILON = 1e-6;
const MAX_SEGMENT_INSERT_DISTANCE_PX = 42;

type DraftPoint = { lat: number; lon: number };
type ForbiddenHoverState = 'none' | 'vertex' | 'segment';
type ForbiddenDragState = { kind: 'idle' } | { kind: 'vertex'; pointIndex: number };
type ForbiddenHitTarget =
  | { kind: 'vertex'; pointIndex: number }
  | { kind: 'segment'; edgeIndex: number };
type ForbiddenHitDiagnostics = {
  target: ForbiddenHitTarget | null;
  pointIndex: number | null;
  edgeIndex: number | null;
  vertexHitCount: number;
  segmentHitCount: number;
};

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
  const [draftPoints, setDraftPoints] = useState<DraftPoint[]>([]);
  const [draftFuture, setDraftFuture] = useState<DraftPoint[][]>([]);
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

  const updateDraftStatus = useCallback((points: DraftPoint[]) => {
    if (points.length <= 0) {
      setStatusMessage('Cliquez pour poser la zone, clic droit pour fermer (3 points minimum)');
      return;
    }
    setStatusMessage(
      points.length >= 3
        ? 'Clic droit pour fermer la zone interdite'
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
      setStatusMessage('Cliquez pour poser la zone, clic droit pour fermer (3 points minimum)');
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

    let dragState: ForbiddenDragState = { kind: 'idle' };
    let hoverState: ForbiddenHoverState = 'none';
    let suppressNextClick = false;
    let lastHoverLogSignature = '';
    let lastDragLogAt = 0;
    let previousBodyCursor = '';
    let previousBodyUserSelect = '';
    let activePointerId: number | null = null;

    const refreshCursor = () => {
      if (dragState.kind === 'vertex') {
        canvas.style.cursor = FORBIDDEN_VERTEX_DRAG_CURSOR;
        return;
      }
      if (hoverState === 'vertex') {
        canvas.style.cursor = FORBIDDEN_VERTEX_CURSOR;
        return;
      }
      if (hoverState === 'segment') {
        canvas.style.cursor = FORBIDDEN_SEGMENT_CURSOR;
        return;
      }
      canvas.style.cursor = FORBIDDEN_CURSOR;
    };

    refreshCursor();

    const setHoverState = (nextHoverState: ForbiddenHoverState) => {
      if (hoverState === nextHoverState) return;
      hoverState = nextHoverState;
      refreshCursor();
    };

    const readHoverStateAtPoint = (point: MapMouseEvent['point']): ForbiddenHoverState => {
      const diagnostics = readDraftHitDiagnostics(map, point);
      if (!diagnostics.target) return 'none';
      return diagnostics.target.kind === 'vertex' ? 'vertex' : 'segment';
    };

    const logHitDiagnostics = (reason: string, point: MapMouseEvent['point'], diagnostics: ForbiddenHitDiagnostics) => {
      console.info('[forbidden-zone-hit]', {
        reason,
        cursor: canvas.style.cursor || FORBIDDEN_CURSOR,
        point: {
          x: Math.round(point.x),
          y: Math.round(point.y),
        },
        target: diagnostics.target,
        vertexHitCount: diagnostics.vertexHitCount,
        segmentHitCount: diagnostics.segmentHitCount,
        vertexIndex: diagnostics.pointIndex,
        edgeIndex: diagnostics.edgeIndex,
      });
    };

    const logDragDiagnostics = (reason: string, pointIndex: number, detail?: Record<string, unknown>) => {
      console.info('[forbidden-zone-drag]', {
        reason,
        pointIndex,
        cursor: canvas.style.cursor || FORBIDDEN_CURSOR,
        ...detail,
      });
    };

    const finalizeDraft = (points: DraftPoint[]): boolean => {
      if (points.length < 3) {
        setStatusMessage(`Zone interdite: ${points.length}/3 points minimum`);
        return false;
      }

      const created = store.addForbiddenZone(activeItinerary.id, points);
      if (!created) return false;
      setArmed(false);
      setDraftPoints([]);
      setDraftFuture([]);
      draftPointsRef.current = [];
      setStatusMessage('Zone interdite enregistrée');
      clearForbiddenZoneDraft(map);
      canvas.style.cursor = '';
      return true;
    };

    const commitDraftPoints = (nextPoints: DraftPoint[]) => {
      draftPointsRef.current = nextPoints;
      setDraftPoints(nextPoints);
      setDraftFuture([]);
      updateDraftStatus(nextPoints);
    };

    const moveDraggedVertex = (lngLat: { lat: number; lng: number }) => {
      if (dragState.kind !== 'vertex') return;
      const pointIndex = dragState.pointIndex;
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

    const readPointFromClientPosition = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;

      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        return null;
      }

      return { x, y };
    };

    const readLngLatFromClientPosition = (clientX: number, clientY: number) => {
      const point = readPointFromClientPosition(clientX, clientY);
      if (!point) return null;
      return {
        point,
        lngLat: map.unproject([point.x, point.y]),
      };
    };

    const startVertexDrag = (pointIndex: number, pointerId: number) => {
      dragState = { kind: 'vertex', pointIndex };
      hoverState = 'vertex';
      suppressNextClick = true;
      activePointerId = pointerId;
      previousBodyCursor = document.body.style.cursor;
      previousBodyUserSelect = document.body.style.userSelect;
      document.body.style.cursor = FORBIDDEN_VERTEX_DRAG_CURSOR;
      document.body.style.userSelect = 'none';
      setStatusMessage('Glissez le sommet pour le déplacer');
      refreshCursor();
      logDragDiagnostics('start', pointIndex);

      try {
        canvas.setPointerCapture(pointerId);
      } catch {
        /* Pointer capture can fail if the browser already released this pointer. */
      }

      window.addEventListener('pointermove', handleWindowDragMove, true);
      window.addEventListener('pointerup', handleWindowDragEnd, true);
      window.addEventListener('pointercancel', handleWindowDragEnd, true);
    };

    const stopVertexDrag = (point?: MapMouseEvent['point']) => {
      window.removeEventListener('pointermove', handleWindowDragMove, true);
      window.removeEventListener('pointerup', handleWindowDragEnd, true);
      window.removeEventListener('pointercancel', handleWindowDragEnd, true);

      if (dragState.kind !== 'vertex') return;
      const pointIndex = dragState.pointIndex;
      dragState = { kind: 'idle' };
      if (activePointerId != null) {
        try {
          if (canvas.hasPointerCapture(activePointerId)) canvas.releasePointerCapture(activePointerId);
        } catch {
          /* noop */
        }
      }
      activePointerId = null;
      document.body.style.cursor = previousBodyCursor;
      document.body.style.userSelect = previousBodyUserSelect;
      hoverState = point ? readHoverStateAtPoint(point) : 'none';
      updateDraftStatus(draftPointsRef.current);
      refreshCursor();
      logDragDiagnostics('end', pointIndex, { hoverState });
    };

    const handleWindowDragMove = (event: PointerEvent) => {
      if (activePointerId != null && event.pointerId !== activePointerId) return;
      const resolved = readLngLatFromClientPosition(event.clientX, event.clientY);
      if (!resolved) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const now = performance.now();
      if (dragState.kind === 'vertex' && now - lastDragLogAt > 250) {
        lastDragLogAt = now;
        logDragDiagnostics('move', dragState.pointIndex, {
          point: {
            x: Math.round(resolved.point.x),
            y: Math.round(resolved.point.y),
          },
          lng: Number(resolved.lngLat.lng.toFixed(6)),
          lat: Number(resolved.lngLat.lat.toFixed(6)),
        });
      }
      moveDraggedVertex(resolved.lngLat);
    };

    const handleWindowDragEnd = (event: PointerEvent) => {
      if (activePointerId != null && event.pointerId !== activePointerId) return;
      const resolved = readLngLatFromClientPosition(event.clientX, event.clientY);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (resolved) {
        moveDraggedVertex(resolved.lngLat);
        stopVertexDrag(resolved.point as MapMouseEvent['point']);
        return;
      }
      stopVertexDrag();
    };

    const handleMapMouseMove = (event: MapMouseEvent) => {
      if (dragState.kind === 'vertex') return;
      const diagnostics = readDraftHitDiagnostics(map, event.point);
      const nextHoverState = diagnostics.target?.kind === 'vertex'
        ? 'vertex'
        : diagnostics.target?.kind === 'segment'
          ? 'segment'
          : 'none';
      const nextLogSignature = [
        nextHoverState,
        diagnostics.pointIndex ?? -1,
        diagnostics.edgeIndex ?? -1,
        diagnostics.vertexHitCount,
        diagnostics.segmentHitCount,
      ].join(':');
      if (nextLogSignature !== lastHoverLogSignature) {
        lastHoverLogSignature = nextLogSignature;
        logHitDiagnostics('hover', event.point, diagnostics);
      }
      setHoverState(nextHoverState);
    };

    const handleCanvasLeave = () => {
      if (dragState.kind === 'vertex') return;
      setHoverState('none');
    };

    const handleCanvasPointerDown = (event: PointerEvent) => {
      if (dragState.kind === 'vertex') return;
      if (event.button !== 0) return;

      const point = readPointFromClientPosition(event.clientX, event.clientY) as MapMouseEvent['point'] | null;
      if (!point) return;

      const diagnostics = readDraftHitDiagnostics(map, point);
      logHitDiagnostics('pointerdown', point, diagnostics);
      const target = diagnostics.target;
      if (!target) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (target.kind === 'vertex') {
        startVertexDrag(target.pointIndex, event.pointerId);
        return;
      }

      const insertion = insertDraftPointOnSegment(map, draftPointsRef.current, point, target.edgeIndex);
      if (!insertion) return;

      commitDraftPoints(insertion.nextPoints);
      startVertexDrag(insertion.pointIndex, event.pointerId);
    };

    const handleMapClick = (event: MapMouseEvent) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const target = readDraftHitTarget(map, event.point);
      if (target) {
        return;
      }

      const currentPoints = draftPointsRef.current;
      const interiorInsert =
        currentPoints.length >= 3 &&
        pointInDraftPolygon({ lat: event.lngLat.lat, lon: event.lngLat.lng }, currentPoints)
          ? insertDraftPointAtNearestSegment(map, currentPoints, event)
          : null;

      const nextPoints =
        interiorInsert ?? appendDraftPoint(currentPoints, { lat: event.lngLat.lat, lon: event.lngLat.lng });

      commitDraftPoints(nextPoints);
    };

    const handleMapContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();
      event.originalEvent.preventDefault();
      event.originalEvent.stopPropagation();
      stopVertexDrag();
      finalizeDraft(draftPointsRef.current);
    };

    map.on('mousemove', handleMapMouseMove);
    map.on('click', handleMapClick);
    map.on('contextmenu', handleMapContextMenu);
    canvas.addEventListener('pointerdown', handleCanvasPointerDown, true);
    canvas.addEventListener('mouseleave', handleCanvasLeave);

    return () => {
      stopVertexDrag();
      map.off('mousemove', handleMapMouseMove);
      map.off('click', handleMapClick);
      map.off('contextmenu', handleMapContextMenu);
      canvas.removeEventListener('pointerdown', handleCanvasPointerDown, true);
      canvas.removeEventListener('mouseleave', handleCanvasLeave);
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
  points: DraftPoint[],
  point: DraftPoint,
): DraftPoint[] {
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
  points: DraftPoint[],
  event: MapMouseEvent,
): DraftPoint[] | null {
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
  left: DraftPoint,
  right: DraftPoint,
): boolean {
  return (
    Math.abs(left.lat - right.lat) <= POINT_EPSILON &&
    Math.abs(left.lon - right.lon) <= POINT_EPSILON
  );
}

function readDraftHitDiagnostics(
  map: MapboxMap,
  point: MapMouseEvent['point'],
): ForbiddenHitDiagnostics {
  const vertexFeatures = readRenderedFeaturesAroundPoint(
    map,
    point,
    FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID,
    HIT_QUERY_RADIUS_PX,
  );
  const segmentFeatures = readRenderedFeaturesAroundPoint(
    map,
    point,
    FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID,
    HIT_QUERY_RADIUS_PX,
  );
  const pointIndex = readIntegerPropertyFromFeatures(vertexFeatures, 'index');
  const edgeIndex = readIntegerPropertyFromFeatures(segmentFeatures, 'edgeIndex');
  const target: ForbiddenHitTarget | null = pointIndex != null
    ? { kind: 'vertex', pointIndex }
    : edgeIndex != null
      ? { kind: 'segment', edgeIndex }
      : null;

  return {
    target,
    pointIndex,
    edgeIndex,
    vertexHitCount: vertexFeatures.length,
    segmentHitCount: segmentFeatures.length,
  };
}

function readDraftHitTarget(
  map: MapboxMap,
  point: MapMouseEvent['point'],
): ForbiddenHitTarget | null {
  return readDraftHitDiagnostics(map, point).target;
}

function readRenderedFeaturesAroundPoint(
  map: MapboxMap,
  point: MapMouseEvent['point'],
  layerId: string,
  queryRadius = 0,
) {
  if (!map.getLayer(layerId)) return [];

  const geometry: MapMouseEvent['point'] | [[number, number], [number, number]] =
    queryRadius > 0
      ? [
          [point.x - queryRadius, point.y - queryRadius],
          [point.x + queryRadius, point.y + queryRadius],
        ]
      : point;

  return map.queryRenderedFeatures(geometry, {
    layers: [layerId],
  });
}

function readIntegerPropertyFromFeatures(
  features: ReturnType<typeof readRenderedFeaturesAroundPoint>,
  propertyName: string,
): number | null {
  for (const feature of features) {
    const propertyValue = feature.properties?.[propertyName];
    const index = typeof propertyValue === 'number' ? propertyValue : Number(propertyValue);
    if (!Number.isInteger(index) || index < 0) continue;
    return index;
  }

  return null;
}

function insertDraftPointOnSegment(
  map: MapboxMap,
  points: DraftPoint[],
  point: MapMouseEvent['point'],
  edgeIndex: number,
): { nextPoints: DraftPoint[]; pointIndex: number } | null {
  const start = points[edgeIndex];
  const end = points[(edgeIndex + 1) % points.length];
  if (!start || !end) return null;

  const startScreen = map.project([start.lon, start.lat]);
  const endScreen = map.project([end.lon, end.lat]);
  const projection = projectPointToSegment(
    point.x,
    point.y,
    startScreen.x,
    startScreen.y,
    endScreen.x,
    endScreen.y,
  );
  const projectedLngLat = map.unproject([projection.x, projection.y]);
  const insertedPoint = { lat: projectedLngLat.lat, lon: projectedLngLat.lng };
  if (sameDraftPoint(start, insertedPoint) || sameDraftPoint(end, insertedPoint)) return null;

  const pointIndex = edgeIndex + 1;
  return {
    nextPoints: [
      ...points.slice(0, pointIndex),
      insertedPoint,
      ...points.slice(pointIndex),
    ],
    pointIndex,
  };
}

function pointInDraftPolygon(
  point: DraftPoint,
  polygon: DraftPoint[],
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