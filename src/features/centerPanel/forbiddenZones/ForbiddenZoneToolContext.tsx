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
import { translateAppText } from '@/shared/i18n';

type DraftPoint = { lat: number; lon: number };
type DraftSnapshot = DraftPoint[];

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
  const [draftHistory, setDraftHistory] = useState<DraftSnapshot[]>([]);
  const [draftHistoryIndex, setDraftHistoryIndex] = useState(-1);

  const draftOverlayRef = useRef<DraftSnapshot>([]);
  const styleReplayFrameRef = useRef<number | null>(null);
  const draftHistoryRef = useRef<DraftSnapshot[]>([]);
  const draftHistoryIndexRef = useRef(-1);
  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const canEdit = Boolean(store && activeItinerary);
  const canUndoDraft = armed && draftHistoryIndex > 0;
  const canRedoDraft = armed && draftHistoryIndex >= 0 && draftHistoryIndex < draftHistory.length - 1;

  const syncHistoryState = useCallback((history: DraftSnapshot[], nextIndex: number) => {
    draftHistoryRef.current = history;
    draftHistoryIndexRef.current = nextIndex;
    setDraftHistory(history);
    setDraftHistoryIndex(nextIndex);
  }, []);

  const updateDraftStatus = useCallback((points: DraftPoint[]) => {
    if (points.length <= 0) {
      setStatusMessage(translateAppText('Zone interdite: cliquez sur la carte pour placer le premier sommet'));
      return;
    }

    setStatusMessage(translateAppText('Polygone prêt: cliquez pour ajouter un sommet, puis recliquez sur Interdire pour enregistrer'));
  }, []);

  const clearDraftOverlay = useCallback(() => {
    if (styleReplayFrameRef.current != null) {
      window.cancelAnimationFrame(styleReplayFrameRef.current);
      styleReplayFrameRef.current = null;
    }
    draftOverlayRef.current = [];
    if (!map) return;
    clearForbiddenZoneDraft(map);
  }, [map]);

  const syncDraftOverlay = useCallback((points: DraftSnapshot) => {
    const nextPoints = cloneDraftSnapshot(points);
    draftOverlayRef.current = nextPoints;

    if (!map) return;

    if (nextPoints.length <= 0) {
      clearForbiddenZoneDraft(map);
      return;
    }

    setForbiddenZoneDraft(map, nextPoints);
  }, [map]);

  const applyDraftSnapshot = useCallback((points: DraftSnapshot) => {
    updateDraftStatus(points);
    syncDraftOverlay(points);
  }, [syncDraftOverlay, updateDraftStatus]);

  const pushDraftSnapshot = useCallback((points: DraftSnapshot) => {
    const currentIndex = draftHistoryIndexRef.current;
    const currentHistory = draftHistoryRef.current;
    const currentSnapshot = currentIndex >= 0 ? currentHistory[currentIndex] : null;
    if (currentSnapshot && draftSnapshotsEqual(currentSnapshot, points)) {
      updateDraftStatus(points);
      return;
    }

    const nextHistory = currentHistory.slice(0, currentIndex + 1);
    nextHistory.push(cloneDraftSnapshot(points));
    const nextIndex = nextHistory.length - 1;
    syncHistoryState(nextHistory, nextIndex);
    updateDraftStatus(points);
    syncDraftOverlay(points);
  }, [syncDraftOverlay, syncHistoryState, updateDraftStatus]);

  const resetDraftSession = useCallback((keepStatusMessage: boolean) => {
    clearDraftOverlay();
    syncHistoryState([], -1);
    if (!keepStatusMessage) setStatusMessage(null);
  }, [clearDraftOverlay, syncHistoryState]);

  const startDraftSession = useCallback(() => {
    syncHistoryState([[]], 0);
    clearDraftOverlay();
    updateDraftStatus([]);
  }, [clearDraftOverlay, syncHistoryState, updateDraftStatus]);

  const deactivate = useCallback(() => {
    setArmed(false);
    setStatusMessage(null);
    resetDraftSession(true);
  }, [resetDraftSession]);

  const toggle = useCallback(() => {
    if (!canEdit) return;

    if (armed) {
      const points = draftOverlayRef.current;

      if (points.length >= 3 && store && activeItinerary) {
        const created = store.addForbiddenZone(activeItinerary.id, points);
        if (!created) {
          setStatusMessage(translateAppText('Impossible d’enregistrer la zone interdite'));
          return;
        }
        setStatusMessage(translateAppText('Zone interdite enregistrée'));
      } else {
        setStatusMessage(null);
      }

      setArmed(false);
      resetDraftSession(true);
      return;
    }

    setArmed(true);
  }, [activeItinerary, armed, canEdit, resetDraftSession, store]);

  const undoDraft = useCallback(() => {
    const nextIndex = draftHistoryIndexRef.current - 1;
    if (nextIndex < 0) return;
    const nextSnapshot = draftHistoryRef.current[nextIndex];
    if (!nextSnapshot) return;
    syncHistoryState(draftHistoryRef.current, nextIndex);
    applyDraftSnapshot(nextSnapshot);
  }, [applyDraftSnapshot, syncHistoryState]);

  const redoDraft = useCallback(() => {
    const nextIndex = draftHistoryIndexRef.current + 1;
    const nextSnapshot = draftHistoryRef.current[nextIndex];
    if (!nextSnapshot) return;
    syncHistoryState(draftHistoryRef.current, nextIndex);
    applyDraftSnapshot(nextSnapshot);
  }, [applyDraftSnapshot, syncHistoryState]);

  const appendDraftPoint = useCallback((lon: number, lat: number) => {
    if (!map) return;

    const currentPoints = cloneDraftSnapshot(draftOverlayRef.current);
    const nextPoints = [...currentPoints, { lon, lat }];

    pushDraftSnapshot(nextPoints);
    applyDraftSnapshot(nextPoints);
  }, [applyDraftSnapshot, map, pushDraftSnapshot]);

  useEffect(() => {
    if (canEdit) return;
    deactivate();
  }, [canEdit, deactivate]);

  useEffect(() => {
    if (!armed) return;
    if (draftHistoryIndexRef.current >= 0) return;
    startDraftSession();
  }, [armed, startDraftSession]);

  // Click & contextmenu listeners for forbidden zone vertices
  useEffect(() => {
    if (!map || !armed || !canEdit) return;

    const canvas = map.getCanvas();
    try {
      canvas.style.cursor = 'crosshair';
    } catch {
      /* noop */
    }

    const handleClick = (event: MapMouseEvent) => {
      appendDraftPoint(event.lngLat.lng, event.lngLat.lat);
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      event.originalEvent.preventDefault();
      event.originalEvent.stopPropagation();
      appendDraftPoint(event.lngLat.lng, event.lngLat.lat);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        deactivate();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        toggle();
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        undoDraft();
      }
    };

    map.on('click', handleClick);
    map.on('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      map.off('click', handleClick);
      map.off('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown);
      try {
        canvas.style.cursor = '';
      } catch {
        /* noop */
      }
    };
  }, [appendDraftPoint, armed, canEdit, deactivate, map, toggle, undoDraft]);

  // Replay draft overlay on style reload
  useEffect(() => {
    if (!map) return;
    const handleStyleReload = () => {
      if (styleReplayFrameRef.current != null) {
        window.cancelAnimationFrame(styleReplayFrameRef.current);
      }

      styleReplayFrameRef.current = window.requestAnimationFrame(() => {
        styleReplayFrameRef.current = null;
        if (!armed) {
          clearDraftOverlay();
          return;
        }
        if (draftOverlayRef.current.length > 0) {
          syncDraftOverlay(draftOverlayRef.current);
        }
      });
    };

    map.on('styledata', handleStyleReload);
    map.on('style.load', handleStyleReload);

    return () => {
      map.off('styledata', handleStyleReload);
      map.off('style.load', handleStyleReload);
      if (styleReplayFrameRef.current != null) {
        window.cancelAnimationFrame(styleReplayFrameRef.current);
        styleReplayFrameRef.current = null;
      }
    };
  }, [armed, clearDraftOverlay, map, syncDraftOverlay]);

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

// eslint-disable-next-line react-refresh/only-export-components
export function useForbiddenZoneToolOptional(): ForbiddenZoneToolContextValue | null {
  return useContext(ForbiddenZoneToolContext);
}

function draftSnapshotsEqual(left: DraftSnapshot, right: DraftSnapshot): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (point, index) => point.lat === right[index]?.lat && point.lon === right[index]?.lon,
  );
}

function cloneDraftSnapshot(points: DraftSnapshot): DraftSnapshot {
  return points.map((point) => ({ ...point }));
}
