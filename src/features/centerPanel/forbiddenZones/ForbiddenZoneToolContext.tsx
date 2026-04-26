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
  setForbiddenZoneDraft,
} from '@/features/itineraryPanel/lib/route-layer';

const FORBIDDEN_CURSOR = 'crosshair';
const POINT_EPSILON = 1e-6;

type DraftPoint = { lat: number; lon: number };

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
      setStatusMessage('Cliquez pour poser le premier point, clic droit pour fermer');
      return;
    }

    setStatusMessage(
      points.length >= 3
        ? 'Cliquez pour ajouter des points, clic droit pour fermer et enregistrer'
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
      setDraftPoints([]);
      setDraftFuture([]);
      if (map) clearForbiddenZoneDraft(map);
      updateDraftStatus([]);
      return next;
    });
  }, [canEdit, map, updateDraftStatus]);

  const undoDraft = useCallback(() => {
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

    canvas.style.cursor = FORBIDDEN_CURSOR;

    const finalizeDraft = (points: DraftPoint[]): boolean => {
      if (points.length < 3) {
        deactivate();
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

    const handleMapClick = (event: MapMouseEvent) => {
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

      const currentPoints = draftPointsRef.current;
      if (currentPoints.length >= 3) {
        finalizeDraft(currentPoints);
        return;
      }

      deactivate();
    };

    map.on('click', handleMapClick);
    map.on('contextmenu', handleMapContextMenu);

    return () => {
      map.off('click', handleMapClick);
      map.off('contextmenu', handleMapContextMenu);
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
