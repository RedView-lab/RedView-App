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

import { translateAppText } from '@/shared/i18n';

import {
  analysisZoneBBox,
  analysisZoneMaxSideKm,
  analysisZoneRingPayload,
  ANALYSIS_ZONE_RECOMMENDED_MAX_SIDE_KM,
  hashAnalysisZone,
  isValidAnalysisZone,
  type AnalysisZone,
  type AnalysisZonePoint,
} from './lib/geometry';
import { keepAnalysisZoneRegistered, postAnalysisZoneToSw } from './lib/swZoneBridge';
import { setAnalysisZoneLayerData } from './lib/zoneLayers';
import {
  clearAnalysisZoneDraft,
  removeAnalysisZoneDraftLayers,
  setAnalysisZoneDraftData,
} from './lib/zoneDraftLayers';
import { loadSlopeState } from '@/features/slope/lib/slope-persist';

/** Widgets gated behind the mandatory analysis zone. */
export type AnalysisWidgetId = 'slope' | 'altitude';

export interface AnalysisZoneContextValue {
  zone: AnalysisZone | null;
  /** Stable hash of the current zone (tile-cache key) — null when no zone. */
  zoneHash: string | null;
  /** True while the polygon drawing tool is armed on the map. */
  isDrawing: boolean;
  /** Number of vertices currently placed in the active draft session. */
  draftPointsCount: number;
  /** Non-blocking hint when the drawn zone is far larger than recommended. */
  zoneHint: string | null;
  startDrawing: () => void;
  cancelDrawing: () => void;
  clearZone: () => void;
  fitZone: () => void;
  undoDraftPoint: () => void;
  commitCurrentDraft: () => void;
  /**
   * Arms the drawing tool and remembers which widget the user tried to
   * enable; the widget is activated automatically when the zone is committed.
   */
  requestZoneForWidget: (widget: AnalysisWidgetId) => void;
  /** Returns (and clears) the widgets waiting for a zone, in request order. */
  takePendingWidgetActivations: () => AnalysisWidgetId[];
  /** Replaces the zone from an external source (project hydration). */
  hydrateZone: (zone: AnalysisZone | null) => void;
}

const AnalysisZoneContext = createContext<AnalysisZoneContextValue | null>(null);

interface AnalysisZoneProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

function createZoneId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `az-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Tolerance in screen pixels to snap to / click the first vertex to close. */
const CLOSING_PIXEL_RADIUS = 22;

export function AnalysisZoneProvider({ children, map }: AnalysisZoneProviderProps) {
  const [zone, setZone] = useState<AnalysisZone | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [draftPointsCount, setDraftPointsCount] = useState(0);
  const [zoneHint, setZoneHint] = useState<string | null>(null);

  const zoneRef = useRef<AnalysisZone | null>(null);
  const isDrawingRef = useRef(false);
  const draftPointsRef = useRef<AnalysisZonePoint[]>([]);
  const cursorPositionRef = useRef<AnalysisZonePoint | null>(null);
  const pendingWidgetsRef = useRef<Set<AnalysisWidgetId>>(new Set());

  zoneRef.current = zone;

  const zoneHash = useMemo(() => (isValidAnalysisZone(zone) ? hashAnalysisZone(zone) : null), [zone]);

  const stopDrawingSession = useCallback(() => {
    isDrawingRef.current = false;
    draftPointsRef.current = [];
    cursorPositionRef.current = null;
    setIsDrawing(false);
    setDraftPointsCount(0);

    if (map) {
      clearAnalysisZoneDraft(map);
      try {
        map.getCanvas().style.cursor = '';
      } catch {
        /* canvas unmounted */
      }
    }
  }, [map]);

  const commitZone = useCallback(
    (rawPoints: AnalysisZonePoint[]) => {
      // Deduplicate consecutive identical points (e.g. from double-clicks)
      const points: AnalysisZonePoint[] = [];
      for (const p of rawPoints) {
        const last = points[points.length - 1];
        if (!last || Math.abs(last.lat - p.lat) > 1e-7 || Math.abs(last.lon - p.lon) > 1e-7) {
          points.push(p);
        }
      }

      if (points.length < 3) {
        stopDrawingSession();
        return;
      }

      const nextZone: AnalysisZone = {
        id: createZoneId(),
        points,
        createdAt: new Date().toISOString(),
      };

      setZone(nextZone);
      zoneRef.current = nextZone;

      // Register in the Service Worker immediately
      postAnalysisZoneToSw(nextZone);

      // Launch progressive 2-pass multi-fetch pipeline across the entire zone
      try {
        const currentZoom = map ? Math.round(map.getZoom()) : 14;
        const zoomLevels = [14];
        if (currentZoom >= 8 && currentZoom <= 17 && !zoomLevels.includes(currentZoom)) {
          zoomLevels.push(currentZoom);
        }

        const [w, s, e, n] = analysisZoneBBox(nextZone);
        const ring = analysisZoneRingPayload(nextZone);
        const tiles: Array<{ z: number; x: number; y: number }> = [];
        const seen = new Set<string>();

        const z = 14;
        const world = 1 << z;
        const minX = Math.max(0, Math.min(world - 1, Math.floor(((w + 180) / 360) * world)));
        const maxX = Math.max(0, Math.min(world - 1, Math.floor(((e + 180) / 360) * world)));
        const minLatRad = (Math.min(85, Math.max(-85, s)) * Math.PI) / 180;
        const maxLatRad = (Math.min(85, Math.max(-85, n)) * Math.PI) / 180;
        const maxY = Math.max(0, Math.min(world - 1, Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + minLatRad / 2)) / (2 * Math.PI)) * world)));
        const minY = Math.max(0, Math.min(world - 1, Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + maxLatRad / 2)) / (2 * Math.PI)) * world)));

        for (let tx = minX; tx <= maxX; tx++) {
          for (let ty = minY; ty <= maxY; ty++) {
            const key = `${z}/${tx}/${ty}`;
            if (!seen.has(key)) {
              seen.add(key);
              tiles.push({ z, x: tx, y: ty });
            }
          }
        }

        const zoneHash = hashAnalysisZone(nextZone);
        const slopeState = loadSlopeState();
        const profile = slopeState.resolution === '0.40m (LIDAR SURFACE)' ? 'default' : 'terrain';
        if (tiles.length > 0 && typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'START_ZONE_SLOPE_PIPELINE',
            profile,
            zone: zoneHash,
            ring,
            tiles,
          });
        }
      } catch {
        /* best-effort prewarm */
      }

      if (map) {
        setAnalysisZoneLayerData(map, nextZone);
      }

      setZoneHint(
        analysisZoneMaxSideKm(nextZone) > ANALYSIS_ZONE_RECOMMENDED_MAX_SIDE_KM
          ? translateAppText('Zone très étendue — les calculs resteront plus lents qu’avec une zone réduite')
          : null,
      );

      stopDrawingSession();
    },
    [map, stopDrawingSession],
  );

  const startDrawing = useCallback(() => {
    if (!map) return;

    // Disarm any previous draft and arm drawing mode
    isDrawingRef.current = true;
    draftPointsRef.current = [];
    cursorPositionRef.current = null;
    setIsDrawing(true);
    setDraftPointsCount(0);

    clearAnalysisZoneDraft(map);

    try {
      map.getCanvas().style.cursor = 'crosshair';
    } catch {
      /* canvas gone */
    }
  }, [map]);

  const cancelDrawing = useCallback(() => {
    pendingWidgetsRef.current.clear();
    stopDrawingSession();
  }, [stopDrawingSession]);

  const undoDraftPoint = useCallback(() => {
    if (!isDrawingRef.current || draftPointsRef.current.length === 0) return;
    draftPointsRef.current.pop();
    setDraftPointsCount(draftPointsRef.current.length);
    if (map) {
      setAnalysisZoneDraftData(
        map,
        draftPointsRef.current,
        cursorPositionRef.current,
        false,
      );
    }
  }, [map]);

  const commitCurrentDraft = useCallback(() => {
    if (!isDrawingRef.current || draftPointsRef.current.length < 3) return;
    commitZone(draftPointsRef.current);
  }, [commitZone]);

  const clearZone = useCallback(() => {
    pendingWidgetsRef.current.clear();
    postAnalysisZoneToSw(null);
    setZone(null);
    zoneRef.current = null;
    setZoneHint(null);
    if (map) {
      setAnalysisZoneLayerData(map, null);
    }
  }, [map]);

  const hydrateZone = useCallback(
    (next: AnalysisZone | null) => {
      const valid = isValidAnalysisZone(next) ? next : null;
      postAnalysisZoneToSw(valid);
      setZone(valid);
      zoneRef.current = valid;
      if (map) {
        setAnalysisZoneLayerData(map, valid);
      }
      setZoneHint(
        valid && analysisZoneMaxSideKm(valid) > ANALYSIS_ZONE_RECOMMENDED_MAX_SIDE_KM
          ? translateAppText('Zone très étendue — les calculs resteront plus lents qu’avec une zone réduite')
          : null,
      );
    },
    [map],
  );

  const fitZone = useCallback(() => {
    if (!map || !isValidAnalysisZone(zoneRef.current)) return;
    const [w, s, e, n] = [
      Math.min(...zoneRef.current.points.map((p) => p.lon)),
      Math.min(...zoneRef.current.points.map((p) => p.lat)),
      Math.max(...zoneRef.current.points.map((p) => p.lon)),
      Math.max(...zoneRef.current.points.map((p) => p.lat)),
    ];
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 80, duration: 650, maxZoom: 16.5, essential: true },
    );
  }, [map]);

  const requestZoneForWidget = useCallback(
    (widget: AnalysisWidgetId) => {
      pendingWidgetsRef.current.add(widget);
      startDrawing();
    },
    [startDrawing],
  );

  const takePendingWidgetActivations = useCallback(() => {
    const pending = Array.from(pendingWidgetsRef.current);
    pendingWidgetsRef.current.clear();
    return pending;
  }, []);

  // ── Native Mapbox Interactive Drawing Engine ───────────────────────────
  useEffect(() => {
    if (!map || !isDrawing) return;

    const canvas = map.getCanvas();
    const applyCrosshair = () => {
      canvas.style.cursor = 'crosshair';
    };

    applyCrosshair();

    const isNearFirstPoint = (pixelPoint: { x: number; y: number }): boolean => {
      if (draftPointsRef.current.length < 3) return false;
      const first = draftPointsRef.current[0];
      if (!first) return false;
      try {
        const firstPixel = map.project([first.lon, first.lat]);
        const dx = pixelPoint.x - firstPixel.x;
        const dy = pixelPoint.y - firstPixel.y;
        return Math.hypot(dx, dy) <= CLOSING_PIXEL_RADIUS;
      } catch {
        return false;
      }
    };

    const handleClick = (event: MapMouseEvent) => {
      const clickPoint = { lon: event.lngLat.lng, lat: event.lngLat.lat };

      // 1. Check if clicking on the first vertex with ≥ 3 points to close & validate
      if (draftPointsRef.current.length >= 3 && isNearFirstPoint(event.point)) {
        commitZone(draftPointsRef.current);
        return;
      }

      // 2. Add vertex to current draft
      draftPointsRef.current.push(clickPoint);
      setDraftPointsCount(draftPointsRef.current.length);

      setAnalysisZoneDraftData(
        map,
        draftPointsRef.current,
        cursorPositionRef.current,
        false,
      );
    };

    const handleMouseMove = (event: MapMouseEvent) => {
      const cursor = { lon: event.lngLat.lng, lat: event.lngLat.lat };
      cursorPositionRef.current = cursor;

      const nearFirst = isNearFirstPoint(event.point);
      canvas.style.cursor = nearFirst ? 'pointer' : 'crosshair';

      setAnalysisZoneDraftData(
        map,
        draftPointsRef.current,
        cursor,
        nearFirst,
      );
    };

    const handleDblClick = (event: MapMouseEvent) => {
      event.preventDefault();
      event.originalEvent?.preventDefault?.();
      event.originalEvent?.stopPropagation?.();

      if (draftPointsRef.current.length >= 3) {
        commitZone(draftPointsRef.current);
      }
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();
      event.originalEvent?.preventDefault?.();
      event.originalEvent?.stopPropagation?.();

      if (draftPointsRef.current.length > 0) {
        // Undo last point on right-click
        draftPointsRef.current.pop();
        setDraftPointsCount(draftPointsRef.current.length);
        setAnalysisZoneDraftData(
          map,
          draftPointsRef.current,
          cursorPositionRef.current,
          false,
        );
      } else {
        // Cancel drawing if right-clicked with no points placed
        cancelDrawing();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelDrawing();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (draftPointsRef.current.length >= 3) {
          commitZone(draftPointsRef.current);
        }
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        if (draftPointsRef.current.length > 0) {
          draftPointsRef.current.pop();
          setDraftPointsCount(draftPointsRef.current.length);
          setAnalysisZoneDraftData(
            map,
            draftPointsRef.current,
            cursorPositionRef.current,
            false,
          );
        }
      }
    };

    map.on('click', handleClick);
    map.on('mousemove', handleMouseMove);
    map.on('dblclick', handleDblClick);
    map.on('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      map.off('click', handleClick);
      map.off('mousemove', handleMouseMove);
      map.off('dblclick', handleDblClick);
      map.off('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown);
      try {
        canvas.style.cursor = '';
      } catch {
        /* canvas gone */
      }
    };
  }, [cancelDrawing, commitZone, isDrawing, map]);

  // ── Committed-zone rendering + Service Worker registration ────────────
  useEffect(() => {
    if (!map) return;
    setAnalysisZoneLayerData(map, isValidAnalysisZone(zone) ? zone : null);
    return keepAnalysisZoneRegistered(isValidAnalysisZone(zone) ? zone : null);
  }, [map, zone]);

  // Replay after basemap/style switches, like every imperative layer here.
  useEffect(() => {
    if (!map) return;
    const replay = () => {
      setAnalysisZoneLayerData(map, isValidAnalysisZone(zoneRef.current) ? zoneRef.current : null);
      if (isDrawingRef.current) {
        setAnalysisZoneDraftData(
          map,
          draftPointsRef.current,
          cursorPositionRef.current,
          false,
        );
      }
    };
    map.on('style.load', replay);
    return () => {
      map.off('style.load', replay);
      clearAnalysisZoneDraft(map);
      removeAnalysisZoneDraftLayers(map);
    };
  }, [map]);

  const value = useMemo<AnalysisZoneContextValue>(
    () => ({
      zone: isValidAnalysisZone(zone) ? zone : null,
      zoneHash,
      isDrawing,
      draftPointsCount,
      zoneHint,
      startDrawing,
      cancelDrawing,
      clearZone,
      fitZone,
      undoDraftPoint,
      commitCurrentDraft,
      requestZoneForWidget,
      takePendingWidgetActivations,
      hydrateZone,
    }),
    [
      cancelDrawing,
      clearZone,
      commitCurrentDraft,
      draftPointsCount,
      fitZone,
      hydrateZone,
      isDrawing,
      requestZoneForWidget,
      startDrawing,
      takePendingWidgetActivations,
      undoDraftPoint,
      zone,
      zoneHash,
      zoneHint,
    ],
  );

  return (
    <AnalysisZoneContext.Provider value={value}>
      {children}
    </AnalysisZoneContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAnalysisZone(): AnalysisZoneContextValue | null {
  return useContext(AnalysisZoneContext);
}
