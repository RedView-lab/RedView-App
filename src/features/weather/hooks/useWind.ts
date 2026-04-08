import { useRef, useEffect, useState, useCallback } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindState } from '../types';
import { computeWindGrid } from '../lib/wind-grid';
import { fetchWindData, clearWindCache } from '../lib/open-meteo';
import {
  initWindParticles,
  updateWindParticles,
  removeWindParticles,
} from '../lib/wind-layer';

// ── Configuration ─────────────────────────────────────────────────────

const DEBOUNCE_MS = 800;
const MIN_FETCH_INTERVAL_MS = 5_000;
const VIEWPORT_SHIFT_THRESHOLD = 0.25;
const ZOOM_DELTA_THRESHOLD = 0.6;
const BOUNDS_PADDING = 0.8;

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
): WindState {
  const [state, setState] = useState<WindState>({
    loading: false,
    error: null,
    pointCount: 0,
    lastUpdate: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const lastBoundsRef = useRef<ViewportBounds | null>(null);
  const lastFetchBoundsRef = useRef<{ north: number; south: number; east: number; west: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layerInitRef = useRef(false);
  const lastFetchTimeRef = useRef(0);

  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch sparse API data → build wind texture → feed particles ──

  const fetchForViewport = useCallback(
    async (m: MapboxMap) => {
      const bounds = getViewportBounds(m);

      // Rate-limit guard: if too soon, schedule a deferred retry
      const timeSinceLastFetch = Date.now() - lastFetchTimeRef.current;
      if (timeSinceLastFetch < MIN_FETCH_INTERVAL_MS) {
        // Schedule retry after cooldown expires (only if not already scheduled)
        if (!retryTimerRef.current) {
          const delay = MIN_FETCH_INTERVAL_MS - timeSinceLastFetch + 100;
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
          if (zoomDelta < ZOOM_DELTA_THRESHOLD * 2) {
            lastBoundsRef.current = bounds;
            return;
          }
        }
      }

      // OR gate: refetch if viewport shifted significantly OR zoom changed
      if (lastBoundsRef.current) {
        const shift = viewportShiftRatio(lastBoundsRef.current, bounds);
        const zoomDelta = Math.abs(lastBoundsRef.current.zoom - bounds.zoom);
        if (shift < VIEWPORT_SHIFT_THRESHOLD && zoomDelta < ZOOM_DELTA_THRESHOLD) return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState((s) => ({ ...s, loading: true, error: null }));

      try {
        // Expand bounds by 50% margin to create a data reservoir
        const latPad = (bounds.north - bounds.south) * BOUNDS_PADDING;
        const lngPad = (bounds.east - bounds.west) * BOUNDS_PADDING;
        const fetchBounds = {
          north: Math.min(90, bounds.north + latPad),
          south: Math.max(-90, bounds.south - latPad),
          east: Math.min(180, bounds.east + lngPad),
          west: Math.max(-180, bounds.west - lngPad),
        };

        const grid = computeWindGrid(fetchBounds, bounds.zoom);
        if (grid.length === 0) {
          setState((s) => ({ ...s, loading: false, pointCount: 0 }));
          return;
        }

        const sparsePoints = await fetchWindData(grid, controller.signal);
        if (controller.signal.aborted) return;

        updateWindParticles(m, sparsePoints, fetchBounds);
        lastBoundsRef.current = bounds;
        lastFetchBoundsRef.current = fetchBounds;
        lastFetchTimeRef.current = Date.now();

        setState({
          loading: false,
          error: null,
          pointCount: sparsePoints.length,
          lastUpdate: Date.now(),
        });
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : 'Wind fetch failed';
        console.error('[wind]', message);
        setState((s) => ({ ...s, loading: false, error: message }));
      }
    },
    [],
  );

  // ── Init / destroy on enable toggle ─────────────────────────────

  useEffect(() => {
    if (!map) return;

    if (enabled) {
      try {
        initWindParticles(map);
        layerInitRef.current = true;
      } catch (err) {
        console.error('[wind] init failed:', err);
        setState((s) => ({ ...s, error: 'Wind particle init failed' }));
        return;
      }

      fetchForViewport(map);

      const onMoveEnd = () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => fetchForViewport(map), DEBOUNCE_MS);
      };
      map.on('moveend', onMoveEnd);

      return () => {
        map.off('moveend', onMoveEnd);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        abortRef.current?.abort();
        removeWindParticles(map);
        layerInitRef.current = false;
        lastBoundsRef.current = null;
        lastFetchBoundsRef.current = null;
        setState({ loading: false, error: null, pointCount: 0, lastUpdate: null });
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
        clearWindCache();
        setState({ loading: false, error: null, pointCount: 0, lastUpdate: null });
      }
    }
  }, [map, enabled, fetchForViewport]);

  return state;
}
