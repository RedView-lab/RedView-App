import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
import {
  clearForbiddenZoneDraft,
  setForbiddenZoneDraft,
} from '@/features/itineraryPanel/lib/route-layer';

const FORBIDDEN_CURSOR = 'url("/svgv2/icone/slash-octagon.svg") 8 8, not-allowed';
const POINT_EPSILON = 1e-6;

interface ForbiddenZoneToolContextValue {
  armed: boolean;
  canEdit: boolean;
  statusMessage: string | null;
  toggle: () => void;
  deactivate: () => void;
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
  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const canEdit = Boolean(store && activeItinerary);

  const resetDraft = useCallback(() => {
    setDraftPoints([]);
    if (map) clearForbiddenZoneDraft(map);
  }, [map]);

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
        if (map) clearForbiddenZoneDraft(map);
        return next;
      }
      setStatusMessage('Cliquez pour poser la zone, double-cliquez pour fermer (3 points minimum)');
      return next;
    });
  }, [canEdit, map]);

  useEffect(() => {
    if (canEdit) return;
    deactivate();
  }, [canEdit, deactivate]);

  useEffect(() => {
    if (!map || !armed) return;
    if (draftPoints.length >= 3) setForbiddenZoneDraft(map, draftPoints);
    else clearForbiddenZoneDraft(map);

    const restoreDraft = () => {
      if (draftPoints.length >= 3) setForbiddenZoneDraft(map, draftPoints);
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
    const applyCursor = () => {
      canvas.style.cursor = FORBIDDEN_CURSOR;
    };

    const handleClick = (event: MapMouseEvent) => {
      const point = { lat: event.lngLat.lat, lon: event.lngLat.lng };
      const nextPoints = appendDraftPoint(draftPoints, point);
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
      setStatusMessage(
        nextPoints.length >= 3
          ? 'Double-cliquez pour fermer la zone interdite'
          : `Zone interdite: ${nextPoints.length}/3 points minimum`,
      );
    };

    if (wasDoubleClickZoomEnabled) map.doubleClickZoom.disable();
    applyCursor();
    map.on('mousemove', applyCursor);
    map.on('click', handleClick);

    return () => {
      map.off('mousemove', applyCursor);
      map.off('click', handleClick);
      if (wasDoubleClickZoomEnabled) map.doubleClickZoom.enable();
      canvas.style.cursor = '';
    };
  }, [activeItinerary, armed, draftPoints, map, store]);

  const value = useMemo<ForbiddenZoneToolContextValue>(
    () => ({
      armed,
      canEdit,
      statusMessage,
      toggle,
      deactivate,
    }),
    [armed, canEdit, deactivate, statusMessage, toggle],
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