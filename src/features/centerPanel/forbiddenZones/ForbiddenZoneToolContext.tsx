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

    setForbiddenZoneDraft(map, draftPointsRef.current);

    const canvas = map.getCanvas();
    const wasDoubleClickZoomEnabled = map.doubleClickZoom.isEnabled();
    const wasDragPanEnabled = map.dragPan.isEnabled();
    let draggedPointIndex: number | null = null;
    let suppressNextClick = false;

    const applyCursor = (event?: MapMouseEvent) => {
      if (draggedPointIndex != null) {
        canvas.style.cursor = FORBIDDEN_VERTEX_DRAG_CURSOR;
        return;
      }
      if (event && findDraftVertexIndexAtEvent(map, event) != null) {
        canvas.style.cursor = FORBIDDEN_VERTEX_CURSOR;
        return;
      }
      canvas.style.cursor = FORBIDDEN_CURSOR;
    };

    const startVertexDrag = (pointIndex: number, originalEvent?: MouseEvent) => {
      draggedPointIndex = pointIndex;
      suppressNextClick = true;
      originalEvent?.preventDefault();
      originalEvent?.stopPropagation();
      canvas.style.cursor = FORBIDDEN_VERTEX_DRAG_CURSOR;
      setStatusMessage('Glissez un sommet pour déplacer la zone');
    };

    const handleVertexMouseDown = (event: MapLayerMouseEvent) => {
      const pointIndex = readVertexIndexFromLayerEvent(event);
      if (pointIndex == null) return;
      startVertexDrag(pointIndex, event.originalEvent as MouseEvent | undefined);
    };

    const handleMouseDown = (event: MapMouseEvent) => {
      const nearestPointIndex = findDraftVertexIndexAtEvent(map, event);
      if (nearestPointIndex == null) return;
      startVertexDrag(nearestPointIndex, event.originalEvent as MouseEvent | undefined);
    };

    const handleMouseMove = (event: MapMouseEvent) => {
      if (draggedPointIndex == null) {
        applyCursor(event);
        return;
      }

      const currentPoints = draftPointsRef.current;
      const nextPoint = { lat: event.lngLat.lat, lon: event.lngLat.lng };
      if (sameDraftPoint(currentPoints[draggedPointIndex], nextPoint)) return;

      const nextPoints = currentPoints.map((point, index) =>
        index === draggedPointIndex ? nextPoint : point,
      );
      draftPointsRef.current = nextPoints;
      setDraftPoints(nextPoints);
      setDraftFuture([]);
      updateDraftStatus(nextPoints);
      canvas.style.cursor = FORBIDDEN_VERTEX_DRAG_CURSOR;
    };

    const handleMouseUp = (event?: MapMouseEvent) => {
      if (draggedPointIndex == null) {
        if (event) applyCursor(event);
        return;
      }
      draggedPointIndex = null;
      updateDraftStatus(draftPointsRef.current);
      if (event) applyCursor(event);
      else canvas.style.cursor = FORBIDDEN_CURSOR;
    };

    const handleClick = (event: MapMouseEvent) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }

      const currentPoints = draftPointsRef.current;
      const nextPoints = insertDraftPointAtNearestSegment(map, currentPoints, event)
        ?? appendDraftPoint(currentPoints, { lat: event.lngLat.lat, lon: event.lngLat.lng });
      const clickCount =
        event.originalEvent instanceof MouseEvent ? event.originalEvent.detail : 1;

      if (clickCount >= 2 && nextPoints.length >= 3) {
        const created = store.addForbiddenZone(activeItinerary.id, nextPoints);
        if (!created) return;
        setArmed(false);
        setDraftPoints([]);
        setStatusMessage('Zone interdite enregistrée');
        clearForbiddenZoneDraft(map);
        canvas.style.cursor = '';
        return;
      }

      setDraftPoints(nextPoints);
      draftPointsRef.current = nextPoints;
      setDraftFuture([]);
      updateDraftStatus(nextPoints);
    };

    if (wasDoubleClickZoomEnabled) map.doubleClickZoom.disable();
    if (wasDragPanEnabled) map.dragPan.disable();
    applyCursor();
    map.on('mousedown', FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID, handleVertexMouseDown);
    map.on('mousedown', handleMouseDown);
    map.on('mousemove', handleMouseMove);
    map.on('mouseup', handleMouseUp);
    map.on('click', handleClick);

    return () => {
      map.off('mousedown', FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID, handleVertexMouseDown);
      map.off('mousedown', handleMouseDown);
      map.off('mousemove', handleMouseMove);
      map.off('mouseup', handleMouseUp);
      map.off('click', handleClick);
      if (wasDoubleClickZoomEnabled) map.doubleClickZoom.enable();
      if (wasDragPanEnabled) map.dragPan.enable();
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

function findDraftVertexIndexAtEvent(
  map: MapboxMap,
  event: MapMouseEvent,
): number | null {
  if (!map.getLayer(FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID)) return null;

  const features = map.queryRenderedFeatures(event.point, {
    layers: [FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID],
  });

  for (const feature of features) {
    const indexValue = feature.properties?.index;
    const index = typeof indexValue === 'number' ? indexValue : Number(indexValue);
    if (!Number.isInteger(index) || index < 0) continue;
    return index;
  }

  return null;
}

function readVertexIndexFromLayerEvent(event: MapLayerMouseEvent): number | null {
  for (const feature of event.features ?? []) {
    const indexValue = feature.properties?.index;
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