import { useRef, useEffect, useState, useCallback } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindState, WindTimeSelection } from '../types';
import { computeWindGrid } from '../lib/wind-grid';
import { fetchWindGridData, prefetchWindGridData, clearWindCache, hasWindGridSelectionCached } from '../lib/open-meteo';
import { createOverlayStatus, type OverlayReloadRegistrar, type OverlayStatusReporter } from '@/features/map3d';
import {
  initWindParticles,
  updateWindParticles,
  removeWindParticles,
} from '../lib/wind-layer';
import { normaliseWindSelection, windSelectionKey } from '../lib/windSelection';

// ── Configuration ─────────────────────────────────────────────────────

const DEBOUNCE_MS = 800;
const MIN_FETCH_INTERVAL_MS = 1_500;
const VIEWPORT_SHIFT_THRESHOLD = 0.25;
const ZOOM_DELTA_THRESHOLD = 1.2;
const BOUNDS_PADDING = 0.8;

const EMPTY_WIND_STATE: WindState = {
  loading: false,
  error: null,
  pointCount: 0,
  lastUpdate: null,
  progress: 0,
  detail: null,
  source: null,
};

// ── Viewport helpers ──────────────────────────────────────────────────

interface ViewportBounds {
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
}

function getViewportBounds(map: MapboxMap): ViewportBounds {
  const b = map.getBounds()!;
  return {
    north: b.getNorth(),
    south: b.getSouth(),
    east: b.getEast(),
    west: b.getWest(),
    zoom: map.getZoom(),
  };
}

function viewportShiftRatio(prev: ViewportBounds, next: ViewportBounds): number {
  const prevW = prev.east - prev.west;
  const prevH = prev.north - prev.south;
  if (prevW === 0 || prevH === 0) return 1;

  const dLng = Math.abs((prev.east + prev.west) / 2 - (next.east + next.west) / 2);
  const dLat = Math.abs((prev.north + prev.south) / 2 - (next.north + next.south) / 2);

  return Math.max(dLng / prevW, dLat / prevH);
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useWind(
  map: MapboxMap | null,
  enabled: boolean,
  selection: WindTimeSelection,
  options: {
    particlesEnabled?: boolean;
    statusReporter?: OverlayStatusReporter;
    registerReload?: OverlayReloadRegistrar;
  } = {},
): WindState {
  const { particlesEnabled = true, statusReporter, registerReload } = options;
  const [state, setState] = useState<WindState>(EMPTY_WIND_STATE);

  const abortRef = useRef<AbortController | null>(null);
  const lastBoundsRef = useRef<ViewportBounds | null>(null);
  const lastFetchBoundsRef = useRef<{ north: number; south: number; east: number; west: number } | null>(null);
  const lastSelectionRef = useRef<WindTimeSelection | null>(null);
  const selectionRef = useRef<WindTimeSelection>(normaliseWindSelection(selection));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layerInitRef = useRef(false);
  const lastFetchTimeRef = useRef(0);

  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionEffectReadyRef = useRef(false);
  selectionRef.current = normaliseWindSelection(selection);

  const publishStatus = useCallback((status: ReturnType<typeof createOverlayStatus> | null) => {
    statusReporter?.(status);
  }, [statusReporter]);

  const syncParticleLayer = useCallback((m: MapboxMap): boolean => {
    if (!particlesEnabled) {
      if (layerInitRef.current) {
        removeWindParticles(m);
      }
      layerInitRef.current = false;
      return false;
    }

    const initialized = initWindParticles(m);
    layerInitRef.current = initialized;
    return initialized;
  }, [particlesEnabled]);

  // ── Fetch regular VPS wind grid → feed particles directly ──

  const fetchForViewport = useCallback(
    async (m: MapboxMap) => {
      const resolvedSelection = selectionRef.current;
      const resolvedSelectionKey = windSelectionKey(resolvedSelection);
      const bounds = getViewportBounds(m);
      const selectionChanged = lastSelectionRef.current == null
        || windSelectionKey(lastSelectionRef.current) !== resolvedSelectionKey;

      // Expand bounds by 50% margin to create a data reservoir
      const latPad = (bounds.north - bounds.south) * BOUNDS_PADDING;
      const lngPad = (bounds.east - bounds.west) * BOUNDS_PADDING;
      const fetchBounds = {
        north: Math.min(90, bounds.north + latPad),
        south: Math.max(-90, bounds.south - latPad),
        east: Math.min(180, bounds.east + lngPad),
        west: Math.max(-180, bounds.west - lngPad),
      };

      const grid = computeWindGrid(fetchBounds, bounds, bounds.zoom);
      const selectionCached = grid.points.length > 0 && hasWindGridSelectionCached(grid, resolvedSelection);

      // Rate-limit guard: if too soon, schedule a deferred retry
      const timeSinceLastFetch = Date.now() - lastFetchTimeRef.current;
      if (timeSinceLastFetch < MIN_FETCH_INTERVAL_MS && !selectionCached && !selectionChanged) {
        // Schedule retry after cooldown expires (only if not already scheduled)
        if (!retryTimerRef.current) {
          const delay = MIN_FETCH_INTERVAL_MS - timeSinceLastFetch + 100;
          setState((s) => ({
            ...s,
            loading: true,
            progress: Math.max(s.progress, 12),
            detail: `Pause API ${Math.ceil(delay / 1000)}s avant nouvelle requête`,
          }));
          publishStatus(createOverlayStatus({
            id: 'wind',
            label: 'Vent',
            state: 'loading',
            progress: 12,
            detail: `Pause API ${Math.ceil(delay / 1000)}s avant nouvelle requête`,
            reloadable: true,
          }));
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            fetchForViewport(m);
          }, delay);
        }
        return;
      }

      // Check if existing data already covers current viewport
      if (lastFetchBoundsRef.current && lastBoundsRef.current) {
        const fb = lastFetchBoundsRef.current;
        const viewportCovered =
          bounds.west >= fb.west && bounds.east <= fb.east &&
          bounds.south >= fb.south && bounds.north <= fb.north;

        if (viewportCovered) {
          // Data covers viewport — only refetch on significant zoom change
          const zoomDelta = Math.abs(lastBoundsRef.current.zoom - bounds.zoom);
          if (!selectionChanged && zoomDelta < ZOOM_DELTA_THRESHOLD * 2) {
            lastBoundsRef.current = bounds;
            return;
          }
        }
      }

      // OR gate: refetch if viewport shifted significantly OR zoom changed
      if (lastBoundsRef.current) {
        const shift = viewportShiftRatio(lastBoundsRef.current, bounds);
        const zoomDelta = Math.abs(lastBoundsRef.current.zoom - bounds.zoom);
        if (!selectionChanged && shift < VIEWPORT_SHIFT_THRESHOLD && zoomDelta < ZOOM_DELTA_THRESHOLD) return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      console.info('[wind] fetch start');
      setState((s) => ({
        ...s,
        loading: true,
        error: null,
        progress: 8,
        detail: 'Préparation de la grille vent',
      }));
      publishStatus(createOverlayStatus({
        id: 'wind',
        label: 'Vent',
        state: 'loading',
        progress: 8,
        detail: 'Préparation de la grille vent',
        reloadable: true,
      }));

      try {
        let resolvedSource: WindState['source'] = null;
        if (grid.points.length === 0) {
          setState((s) => ({
            ...s,
            loading: false,
            pointCount: 0,
            progress: 0,
            detail: 'Aucune grille vent disponible',
          }));
          publishStatus(createOverlayStatus({
            id: 'wind',
            label: 'Vent',
            state: 'error',
            progress: 0,
            detail: 'Aucune grille vent disponible',
            reloadable: true,
          }));
          return;
        }

        setState((s) => ({
          ...s,
          loading: true,
          progress: 22,
          detail: `Vent ${resolvedSelection.date} ${resolvedSelection.time} ${grid.cols}×${grid.rows}`,
        }));
        publishStatus(createOverlayStatus({
          id: 'wind',
          label: 'Vent',
          state: 'loading',
          progress: 22,
          detail: `Vent ${resolvedSelection.date} ${resolvedSelection.time} ${grid.cols}×${grid.rows}`,
          reloadable: true,
        }));

        const windPoints = await fetchWindGridData(grid, resolvedSelection, controller.signal, ({
          completedBatches,
          totalBatches,
          source,
          detail,
        }) => {
          if (source) resolvedSource = source;
          const batchRatio = totalBatches > 0 ? completedBatches / totalBatches : 0;
          setState((s) => ({
            ...s,
            loading: true,
            progress: Math.min(96, 28 + Math.round(batchRatio * 58)),
            detail,
            source: source ?? s.source,
          }));
          publishStatus(createOverlayStatus({
            id: 'wind',
            label: 'Vent',
            state: 'loading',
            progress: Math.min(96, 28 + Math.round(batchRatio * 58)),
            detail,
            reloadable: true,
          }));
        });
        if (controller.signal.aborted) return;

        if (particlesEnabled && layerInitRef.current) {
          updateWindParticles(m, grid, windPoints);
        }
        lastBoundsRef.current = bounds;
        lastFetchBoundsRef.current = grid.bounds;
        lastSelectionRef.current = resolvedSelection;
        lastFetchTimeRef.current = Date.now();

        void prefetchWindGridData(grid, resolvedSelection, controller.signal);

        console.info(`[wind] ready with direct grid ${grid.cols}x${grid.rows} (${windPoints.length} points)`);

        const nextState = {
          loading: false,
          error: null,
          pointCount: windPoints.length,
          lastUpdate: Date.now(),
          progress: 100,
          detail: 'Champ de vent chargé',
          source: resolvedSource,
        };
        setState(nextState);
        publishStatus(createOverlayStatus({
          id: 'wind',
          label: 'Vent',
          state: 'ready',
          progress: 100,
          detail: nextState.detail ?? undefined,
          reloadable: true,
        }));
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : 'Wind fetch failed';
        console.error('[wind]', message);
        setState((s) => ({
          ...s,
          loading: false,
          error: message,
          progress: 0,
          detail: 'Impossible de charger le vent',
        }));
        publishStatus(createOverlayStatus({
          id: 'wind',
          label: 'Vent',
          state: 'error',
          progress: 0,
          detail: message,
          reloadable: true,
        }));
      }
    },
    [particlesEnabled, publishStatus],
  );

  useEffect(() => {
    if (!selectionEffectReadyRef.current) {
      selectionEffectReadyRef.current = true;
      return;
    }
    if (!map || !enabled) return;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    void fetchForViewport(map);
  }, [enabled, fetchForViewport, map, selection.date, selection.time]);

  // ── Init / destroy on enable toggle ─────────────────────────────

  useEffect(() => {
    if (!map) {
      if (enabled) {
        setState((s) => ({
          ...s,
          loading: false,
          error: null,
          detail: 'Carte non prête, attente du chargement Mapbox',
          progress: 0,
        }));
        publishStatus(createOverlayStatus({
          id: 'wind',
          label: 'Vent',
          state: 'loading',
          progress: 0,
          detail: 'Carte non prête, attente du chargement Mapbox',
          reloadable: true,
        }));
      }
      return;
    }

    if (enabled) {
      try {
        syncParticleLayer(map);
      } catch (err) {
        console.error('[wind] init failed:', err);
        setState((s) => ({ ...s, error: 'Wind particle init failed' }));
        publishStatus(createOverlayStatus({
          id: 'wind',
          label: 'Vent',
          state: 'error',
          progress: 0,
          detail: 'Wind particle init failed',
          reloadable: true,
        }));
        return;
      }

      fetchForViewport(map);

      const onMoveEnd = () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => fetchForViewport(map), DEBOUNCE_MS);
      };
      const onZoom = () => {
        try {
          const wasInitialized = layerInitRef.current;
          const isInitialized = syncParticleLayer(map);
          if (isInitialized && !wasInitialized) {
            lastBoundsRef.current = null;
            lastFetchBoundsRef.current = null;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => fetchForViewport(map), 50);
          }
        } catch (err) {
          console.warn('[wind] particle sync during zoom failed', err);
        }
      };
      map.on('moveend', onMoveEnd);
      map.on('zoom', onZoom);

      // Re-add the custom particle layer after every style swap. Mapbox
      // wipes all custom layers on style.load and there's no built-in
      // recovery — without this, switching basemaps (or any internal
      // styledata reload) silently removes the wind layer and the user
      // sees no particles even though the toggle reads as enabled.
      const onStyleLoad = () => {
        try {
          syncParticleLayer(map);
          // Force a re-fetch so the freshly-initialised GPU texture has
          // data; clear viewport refs so the "already covered" early
          // exit in fetchForViewport doesn't skip the re-feed.
          lastBoundsRef.current = null;
          lastFetchBoundsRef.current = null;
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => fetchForViewport(map), 50);
        } catch (err) {
          console.warn('[wind] re-init after style.load failed', err);
        }
      };
      map.on('style.load', onStyleLoad);

      return () => {
        map.off('moveend', onMoveEnd);
        map.off('zoom', onZoom);
        map.off('style.load', onStyleLoad);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        abortRef.current?.abort();
        if (layerInitRef.current) removeWindParticles(map);
        layerInitRef.current = false;
        lastBoundsRef.current = null;
        lastFetchBoundsRef.current = null;
        lastSelectionRef.current = null;
        setState(EMPTY_WIND_STATE);
        publishStatus(null);
      };
    } else {
      if (layerInitRef.current) {
        abortRef.current?.abort();
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        removeWindParticles(map);
        layerInitRef.current = false;
        lastBoundsRef.current = null;
        lastFetchBoundsRef.current = null;
        lastSelectionRef.current = null;
        clearWindCache();
        setState(EMPTY_WIND_STATE);
      } else {
        abortRef.current?.abort();
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        lastBoundsRef.current = null;
        lastFetchBoundsRef.current = null;
        lastSelectionRef.current = null;
        clearWindCache();
        setState(EMPTY_WIND_STATE);
      }
      publishStatus(null);
    }
  }, [map, enabled, fetchForViewport, particlesEnabled, publishStatus, syncParticleLayer]);

  useEffect(() => {
    if (!registerReload) return;
    if (!map || !enabled) {
      registerReload(null);
      return;
    }
    registerReload(() => {
      clearWindCache();
      lastFetchBoundsRef.current = null;
      lastBoundsRef.current = null;
      lastSelectionRef.current = null;
      lastFetchTimeRef.current = 0;
      abortRef.current?.abort();
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      void fetchForViewport(map);
    });
    return () => {
      registerReload(null);
    };
  }, [enabled, fetchForViewport, map, registerReload]);

  return state;
}
