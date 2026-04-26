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

type DraftPoint = { lat: number; lon: number };
type DraftStatusMode = 'drawing' | 'moving';
type ForbiddenHoverState = 'none' | 'vertex' | 'segment';
type ForbiddenInteractionState =
  | { kind: 'drawing' }
  | { kind: 'moving'; pointIndex: number };
type ForbiddenHitTarget =
  | { kind: 'vertex'; pointIndex: number }
  | { kind: 'segment'; edgeIndex: number };

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
  const interactionRef = useRef<ForbiddenInteractionState>({ kind: 'drawing' });
  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const canEdit = Boolean(store && activeItinerary);
  const canUndoDraft = draftPoints.length > 0;
  const canRedoDraft = draftFuture.length > 0;

  const resetDraft = useCallback(() => {
    interactionRef.current = { kind: 'drawing' };
    setDraftPoints([]);
    setDraftFuture([]);
    if (map) clearForbiddenZoneDraft(map);
  }, [map]);

  const updateDraftStatus = useCallback((points: DraftPoint[], mode: DraftStatusMode = 'drawing') => {
    if (mode === 'moving') {
      setStatusMessage('Deplacez le sommet puis cliquez pour confirmer');
      return;
    }

    if (points.length <= 0) {
      setStatusMessage('Cliquez pour poser le premier point, clic droit pour fermer');
      return;
    }

    setStatusMessage(
      points.length >= 3
        ? 'Cliquez un sommet pour le deplacer, clic droit pour fermer et enregistrer'
        : `Zone interdite: ${points.length}/3 points minimum`,
    );
  }, []);

  const deactivate = useCallback(() => {
    interactionRef.current = { kind: 'drawing' };
    setArmed(false);
    setStatusMessage(null);
    resetDraft();
  }, [resetDraft]);

  const toggle = useCallback(() => {
    if (!canEdit) return;
    setArmed((current) => {
      const next = !current;
      interactionRef.current = { kind: 'drawing' };
      if (!next) {
        setStatusMessage(null);
        setDraftPoints([]);
        setDraftFuture([]);
        if (map) clearForbiddenZoneDraft(map);
        return next;
      }
      setDraftPoints([]);
      setDraftFuture([]);
      if (map) clearForbiddenZoneDraft(map);
      updateDraftStatus([]);
      return next;
    });
  }, [canEdit, map, updateDraftStatus]);

  const undoDraft = useCallback(() => {
    interactionRef.current = { kind: 'drawing' };
    setDraftPoints((current) => {
      if (current.length === 0) return current;
      const next = current.slice(0, -1);
      draftPointsRef.current = next;
      setDraftFuture((future) => [current, ...future]);
      updateDraftStatus(next);
      return next;
    });
  }, [updateDraftStatus]);

  const redoDraft = useCallback(() => {
    interactionRef.current = { kind: 'drawing' };
    setDraftFuture((future) => {
      const [nextPoints, ...rest] = future;
      if (!nextPoints) return future;
      draftPointsRef.current = nextPoints;
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

    interactionRef.current = { kind: 'drawing' };
    let hoverState: ForbiddenHoverState = 'none';

    const refreshCursor = () => {
      if (interactionRef.current.kind === 'moving') {
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
      const target = readDraftHitTarget(map, point);
      if (!target) return 'none';
      return target.kind === 'vertex' ? 'vertex' : 'segment';
    };

    const finalizeDraft = (points: DraftPoint[]): boolean => {
      if (points.length < 3) {
        deactivate();
        return false;
      }

      const created = store.addForbiddenZone(activeItinerary.id, points);
      if (!created) return false;
      interactionRef.current = { kind: 'drawing' };
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
      interactionRef.current = { kind: 'drawing' };
      draftPointsRef.current = nextPoints;
      setDraftPoints(nextPoints);
      setDraftFuture([]);
      updateDraftStatus(nextPoints);
    };

    const replaceDraftPoints = (nextPoints: DraftPoint[]) => {
      draftPointsRef.current = nextPoints;
      setDraftPoints(nextPoints);
    };

    const beginVertexMove = (pointIndex: number) => {
      interactionRef.current = { kind: 'moving', pointIndex };
      hoverState = 'vertex';
      setDraftFuture([]);
      updateDraftStatus(draftPointsRef.current, 'moving');
      refreshCursor();
    };

    const confirmVertexMove = (point?: MapMouseEvent['point']) => {
      if (interactionRef.current.kind !== 'moving') return;
      interactionRef.current = { kind: 'drawing' };
      hoverState = point ? readHoverStateAtPoint(point) : 'none';
      updateDraftStatus(draftPointsRef.current);
      refreshCursor();
    };

    const moveActiveVertex = (lngLat: { lat: number; lng: number }) => {
      if (interactionRef.current.kind !== 'moving') return;
      const pointIndex = interactionRef.current.pointIndex;
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
      replaceDraftPoints(next);
    };

    const handleMapMouseMove = (event: MapMouseEvent) => {
      if (interactionRef.current.kind === 'moving') {
        moveActiveVertex(event.lngLat);
        return;
      }
      setHoverState(readHoverStateAtPoint(event.point));
    };

    const handleCanvasLeave = () => {
      if (interactionRef.current.kind === 'moving') return;
      setHoverState('none');
    };

    const handleMapClick = (event: MapMouseEvent) => {
      if (interactionRef.current.kind === 'moving') {
        confirmVertexMove(event.point);
        return;
      }

      const target = readDraftHitTarget(map, event.point);

      if (target?.kind === 'vertex') {
        beginVertexMove(target.pointIndex);
        return;
      }

      if (target?.kind === 'segment') {
        const insertion = insertDraftPointOnSegment(map, draftPointsRef.current, event.point, target.edgeIndex);
        if (!insertion) return;
        replaceDraftPoints(insertion.nextPoints);
        setDraftFuture([]);
        beginVertexMove(insertion.pointIndex);
        return;
      }

      const nextPoints = appendDraftPoint(draftPointsRef.current, {
        lat: event.lngLat.lat,
        lon: event.lngLat.lng,
      });
      if (nextPoints === draftPointsRef.current) return;

      commitDraftPoints(nextPoints);
    };

    const handleMapContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();
      event.originalEvent.preventDefault();
      event.originalEvent.stopPropagation();

      if (interactionRef.current.kind === 'moving') {
        confirmVertexMove(event.point);
      }

      const currentPoints = draftPointsRef.current;
      if (currentPoints.length >= 3) {
        finalizeDraft(currentPoints);
        return;
      }

      deactivate();
    };

    map.on('mousemove', handleMapMouseMove);
    map.on('click', handleMapClick);
    map.on('contextmenu', handleMapContextMenu);
    canvas.addEventListener('mouseleave', handleCanvasLeave);

    return () => {
      interactionRef.current = { kind: 'drawing' };
      map.off('mousemove', handleMapMouseMove);
      map.off('click', handleMapClick);
      map.off('contextmenu', handleMapContextMenu);
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
): ForbiddenHitTarget | null {
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
  if (pointIndex != null) {
    return { kind: 'vertex', pointIndex };
  }

  const edgeIndex = readIntegerPropertyFromFeatures(segmentFeatures, 'edgeIndex');
  if (edgeIndex != null) {
    return { kind: 'segment', edgeIndex };
  }

  return null;
}

function readDraftHitTarget(
  map: MapboxMap,
  point: MapMouseEvent['point'],
): ForbiddenHitTarget | null {
  return readDraftHitDiagnostics(map, point);
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