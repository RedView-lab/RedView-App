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
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import type { Feature, Polygon } from 'geojson';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
import {
  clearForbiddenZoneDraft,
  setForbiddenZoneDraft,
} from '@/features/itineraryPanel/lib/route-layer';
import { translateAppText } from '@/shared/i18n';

type DraftPoint = { lat: number; lon: number };
type DraftSnapshot = DraftPoint[];

const DRAW_CONTROL_GROUP_SELECTOR = '.mapbox-gl-draw_polygon';
const DRAW_HOT_SOURCE_ID = 'mapbox-gl-draw-hot';
const DRAW_COLD_SOURCE_ID = 'mapbox-gl-draw-cold';

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
  const drawRef = useRef<MapboxDraw | null>(null);
  const drawControlElementRef = useRef<HTMLElement | null>(null);

  const draftFeatureIdRef = useRef<string | null>(null);
  const draftOverlayRef = useRef<DraftSnapshot>([]);
  const suppressDrawSyncRef = useRef(false);
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
      setStatusMessage(translateAppText('Zone interdite: clic droit pour placer le premier sommet'));
      return;
    }

    setStatusMessage(translateAppText('Polygone prêt: clic droit pour ajouter un sommet, éditez les poignées puis recliquez sur Interdire pour enregistrer'));
  }, []);

  const setDrawControlVisible = useCallback((visible: boolean) => {
    if (drawControlElementRef.current) {
      drawControlElementRef.current.style.visibility = visible ? 'visible' : 'hidden';
      drawControlElementRef.current.style.pointerEvents = visible ? 'auto' : 'none';
      if (!visible) {
        drawControlElementRef.current.style.position = 'absolute';
        drawControlElementRef.current.style.opacity = '0';
      } else {
        drawControlElementRef.current.style.position = '';
        drawControlElementRef.current.style.opacity = '1';
      }
    }
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

  const activatePolygonMode = useCallback(() => {
    const draw = drawRef.current;
    if (!draw) return;

    // Use the Draw API directly. We defer this slightly so that any prior
    // operations (like draw.deleteAll) and React renders (like setting
    // display: block on the control) have time to settle.
    if (draw.getMode() !== 'draw_polygon') {
      setTimeout(() => {
        try {
          if (drawRef.current && drawRef.current.getMode() !== 'draw_polygon') {
            drawRef.current.changeMode('draw_polygon');
          }
        } catch (err) {
          console.error('[ForbiddenZone] Failed to activate draw_polygon mode:', err);
        }
      }, 50);
    }
  }, [map]);

  const clearDrawDraft = useCallback(() => {
    const draw = drawRef.current;
    if (!draw) return;
    suppressDrawSyncRef.current = true;
    try {
      draw.deleteAll();
      draftFeatureIdRef.current = null;
    } finally {
      suppressDrawSyncRef.current = false;
    }
  }, []);

  const applyDraftSnapshot = useCallback((points: DraftSnapshot) => {
    const draw = drawRef.current;
    if (!draw) return;

    suppressDrawSyncRef.current = true;
    try {
      draw.deleteAll();
      draftFeatureIdRef.current = null;

      if (points.length >= 3) {
        const nextFeatureId = coerceFeatureId(
          draw.add(buildDraftFeature(points)),
        );
        draftFeatureIdRef.current = nextFeatureId;
        if (nextFeatureId) {
          draw.changeMode('direct_select', { featureId: nextFeatureId });
        }
      } else if (armed) {
        activatePolygonMode();
      }
    } finally {
      suppressDrawSyncRef.current = false;
    }

    updateDraftStatus(points);
    syncDraftOverlay(points);
  }, [activatePolygonMode, armed, syncDraftOverlay, updateDraftStatus]);

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
    clearDrawDraft();
    clearDraftOverlay();
    syncHistoryState([], -1);
    if (!keepStatusMessage) setStatusMessage(null);
  }, [clearDraftOverlay, clearDrawDraft, syncHistoryState]);

  const startDraftSession = useCallback(() => {
    const draw = drawRef.current;
    if (!draw) return;
    syncHistoryState([[]], 0);
    clearDrawDraft();
    updateDraftStatus([]);
    suppressDrawSyncRef.current = true;
    try {
      activatePolygonMode();
    } finally {
      suppressDrawSyncRef.current = false;
    }
  }, [activatePolygonMode, clearDrawDraft, syncHistoryState, updateDraftStatus]);

  const deactivate = useCallback(() => {
    setArmed(false);
    setStatusMessage(null);
    resetDraftSession(true);
  }, [resetDraftSession]);

  const toggle = useCallback(() => {
    if (!canEdit) return;

    if (armed) {
      const draw = drawRef.current;
      const points = draw ? getDraftPointsFromDraw(draw, draftFeatureIdRef.current).points : [];

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
    // startDraftSession will be called automatically by the useEffect that listens to armed

  }, [activeItinerary, armed, canEdit, resetDraftSession, startDraftSession, store]);

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
    const draw = drawRef.current;
    if (!draw || !map) return;

    const currentPoints =
      draftOverlayRef.current.length > 0
        ? cloneDraftSnapshot(draftOverlayRef.current)
        : getVisibleDraftPoints(map, draw, draftFeatureIdRef.current);
    const nextPoints = [...currentPoints, { lon, lat }];

    pushDraftSnapshot(nextPoints);
    applyDraftSnapshot(nextPoints);
  }, [applyDraftSnapshot, map, pushDraftSnapshot]);

  useEffect(() => {
    if (canEdit) return;
    deactivate();
  }, [canEdit, deactivate]);

  useEffect(() => {
    setDrawControlVisible(armed);
  }, [armed, setDrawControlVisible]);

  useEffect(() => {
    if (!map || drawRef.current) return;

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: {
        polygon: true,
        trash: true,
      },
      defaultMode: 'simple_select',
    });

    drawRef.current = draw;
    map.addControl(draw, 'top-right');

    const frame = window.requestAnimationFrame(() => {
      const polygonButton = map
        .getContainer()
        .querySelector(DRAW_CONTROL_GROUP_SELECTOR);
      drawControlElementRef.current =
        (polygonButton?.closest('.mapboxgl-ctrl-group') as HTMLElement | null);
      // Visibility is managed by the dedicated armed-visibility effect;
      // hide by default so the native Draw UI never flashes on screen.
      setDrawControlVisible(false);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      drawControlElementRef.current = null;
      drawRef.current = null;
      clearDraftOverlay();
      try {
        map.removeControl(draw);
      } catch {
        // Map teardown can already detach Draw before this effect cleans up.
      }
    };
    // `armed` intentionally excluded: toggling the tool must NOT destroy /
    // recreate the Draw control — that would reset its mode to simple_select
    // and discard any in-progress polygon draft. Control visibility is driven
    // by the separate `setDrawControlVisible(armed)` effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearDraftOverlay, map, setDrawControlVisible]);

  useEffect(() => {
    if (!map) return;
    const draw = drawRef.current;
    if (!draw) return;

    const syncDraftOverlayFromDraw = () => {
      if (suppressDrawSyncRef.current) return;

      const points = getVisibleDraftPoints(map, draw, draftFeatureIdRef.current);
      if (points.length <= 0) {
        if (draftOverlayRef.current.length > 0) {
          syncDraftOverlay(draftOverlayRef.current);
          return;
        }
        clearDraftOverlay();
        return;
      }

      syncDraftOverlay(points);
    };

    const syncDraftFromDraw = (enterDirectSelect: boolean) => {
      if (suppressDrawSyncRef.current) return;

      const { featureId, points, redundantFeatureIds } = getDraftPointsFromDraw(
        draw,
        draftFeatureIdRef.current,
      );

      if (redundantFeatureIds.length > 0) {
        suppressDrawSyncRef.current = true;
        try {
          draw.delete(redundantFeatureIds);
        } finally {
          suppressDrawSyncRef.current = false;
        }
      }

      draftFeatureIdRef.current = featureId;
      pushDraftSnapshot(points);

      if (!armed) return;

      if (featureId && enterDirectSelect) {
        suppressDrawSyncRef.current = true;
        try {
          draw.changeMode('direct_select', { featureId });
        } finally {
          suppressDrawSyncRef.current = false;
        }
        return;
      }

      if (!featureId && draw.getMode() !== 'draw_polygon') {
        suppressDrawSyncRef.current = true;
        try {
          activatePolygonMode();
        } finally {
          suppressDrawSyncRef.current = false;
        }
      }
    };

    const handleDrawCreate = () => syncDraftFromDraw(true);
    const handleDrawUpdate = () => syncDraftFromDraw(false);
    const handleDrawDelete = () => syncDraftFromDraw(false);
    const handleDrawRender = () => syncDraftOverlayFromDraw();
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

        syncDraftOverlayFromDraw();
      });
    };

    map.on('draw.create', handleDrawCreate);
    map.on('draw.update', handleDrawUpdate);
    map.on('draw.delete', handleDrawDelete);
    map.on('draw.render', handleDrawRender);
    map.on('styledata', handleStyleReload);
    map.on('style.load', handleStyleReload);

    return () => {
      map.off('draw.create', handleDrawCreate);
      map.off('draw.update', handleDrawUpdate);
      map.off('draw.delete', handleDrawDelete);
      map.off('draw.render', handleDrawRender);
      map.off('styledata', handleStyleReload);
      map.off('style.load', handleStyleReload);
      if (styleReplayFrameRef.current != null) {
        window.cancelAnimationFrame(styleReplayFrameRef.current);
        styleReplayFrameRef.current = null;
      }
    };
  }, [activatePolygonMode, armed, clearDraftOverlay, map, pushDraftSnapshot, syncDraftOverlay]);

  useEffect(() => {
    if (!map || !armed || !canEdit) return;

    const handleContextMenu = (event: MapMouseEvent) => {
      event.originalEvent.preventDefault();
      event.originalEvent.stopPropagation();
      appendDraftPoint(event.lngLat.lng, event.lngLat.lat);
    };

    map.on('contextmenu', handleContextMenu);
    return () => {
      map.off('contextmenu', handleContextMenu);
    };
  }, [appendDraftPoint, armed, canEdit, map]);

  useEffect(() => {
    if (!armed) return;
    if (draftHistoryIndexRef.current >= 0) return;
    startDraftSession();
  }, [armed, startDraftSession]);

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

function buildDraftFeature(points: DraftSnapshot): Feature<Polygon> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [closeRing(points.map((point) => [point.lon, point.lat]))],
    },
  };
}

function getDraftPointsFromDraw(
  draw: MapboxDraw,
  preferredFeatureId: string | null,
): { featureId: string | null; points: DraftSnapshot; redundantFeatureIds: string[] } {
  const polygonFeatures = draw.getAll().features.filter(isPolygonFeature);
  if (polygonFeatures.length === 0) {
    return { featureId: null, points: [], redundantFeatureIds: [] };
  }

  const activeFeature =
    (preferredFeatureId
      ? polygonFeatures.find((feature) => coerceFeatureId(feature.id) === preferredFeatureId)
      : null) ?? polygonFeatures[polygonFeatures.length - 1];

  if (!activeFeature) {
    return { featureId: null, points: [], redundantFeatureIds: [] };
  }

  const activeId = coerceFeatureId(activeFeature.id);
  return {
    featureId: activeId,
    points: polygonFeatureToDraftSnapshot(activeFeature),
    redundantFeatureIds: polygonFeatures
      .map((feature) => coerceFeatureId(feature.id))
      .filter((featureId): featureId is string => Boolean(featureId) && featureId !== activeId),
  };
}

function getVisibleDraftPoints(
  map: MapboxMap,
  draw: MapboxDraw,
  preferredFeatureId: string | null,
): DraftSnapshot {
  const sourcePoints = getDraftPointsFromDrawSources(map, preferredFeatureId);
  if (sourcePoints.length > 0) {
    return sourcePoints;
  }

  return getDraftPointsFromDraw(draw, preferredFeatureId).points;
}

function getDraftPointsFromDrawSources(
  map: MapboxMap,
  preferredFeatureId: string | null,
): DraftSnapshot {
  const polygonFeatures = [DRAW_HOT_SOURCE_ID, DRAW_COLD_SOURCE_ID].flatMap((sourceId) =>
    getPolygonFeaturesFromDrawSource(map, sourceId),
  );

  if (polygonFeatures.length === 0) {
    return [];
  }

  const activeFeature =
    polygonFeatures.find((feature) => feature.properties?.active === 'true') ??
    (preferredFeatureId
      ? polygonFeatures.find((feature) => coerceFeatureId(feature.id) === preferredFeatureId)
      : null) ??
    polygonFeatures[polygonFeatures.length - 1];

  return activeFeature ? polygonFeatureToDraftSnapshot(activeFeature) : [];
}

function getPolygonFeaturesFromDrawSource(
  map: MapboxMap,
  sourceId: string,
): Array<Feature<Polygon>> {
  try {
    const source = map.getSource(sourceId) as
      | { serialize?: () => { data?: unknown } }
      | undefined;
    const data = source?.serialize?.().data;
    if (!isFeatureCollection(data)) {
      return [];
    }

    return data.features.filter(isPolygonFeature);
  } catch {
    return [];
  }
}

function polygonFeatureToDraftSnapshot(feature: Feature<Polygon>): DraftSnapshot {
  const ring = feature.geometry.coordinates[0] ?? [];
  if (ring.length <= 1) return [];

  const points = ring.slice(0, -1);
  return points.map(([lon, lat]) => ({ lon, lat }));
}

function isPolygonFeature(feature: GeoJSON.Feature): feature is Feature<Polygon> {
  return feature.geometry.type === 'Polygon';
}

function isFeatureCollection(value: unknown): value is GeoJSON.FeatureCollection {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybeFeatureCollection = value as { type?: unknown; features?: unknown };
  return maybeFeatureCollection.type === 'FeatureCollection' && Array.isArray(maybeFeatureCollection.features);
}

function closeRing(coordinates: number[][]): number[][] {
  const first = coordinates[0];
  if (!first) return coordinates;
  return [...coordinates, first];
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

function coerceFeatureId(value: unknown): string | null {
  if (Array.isArray(value)) {
    const [first] = value;
    return first == null ? null : String(first);
  }
  return value == null ? null : String(value);
}
