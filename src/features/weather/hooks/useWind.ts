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
const VIEWPORT_SHIFT_THRESHOLD = 0.15;

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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layerInitRef = useRef(false);

  // ── Fetch sparse API data → build wind texture → feed particles ──

  const fetchForViewport = useCallback(
    async (m: MapboxMap) => {
      const bounds = getViewportBounds(m);

      if (lastBoundsRef.current) {
        const shift = viewportShiftRatio(lastBoundsRef.current, bounds);
        const zoomDelta = Math.abs(lastBoundsRef.current.zoom - bounds.zoom);
        if (shift < VIEWPORT_SHIFT_THRESHOLD && zoomDelta < 0.5) return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState((s) => ({ ...s, loading: true, error: null }));

      try {
        const grid = computeWindGrid(bounds, bounds.zoom);
        if (grid.length === 0) {
          setState((s) => ({ ...s, loading: false, pointCount: 0 }));
          return;
        }

        const sparsePoints = await fetchWindData(grid, controller.signal);
        if (controller.signal.aborted) return;

        updateWindParticles(m, sparsePoints, bounds);
        lastBoundsRef.current = bounds;

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
        abortRef.current?.abort();
        removeWindParticles(map);
        layerInitRef.current = false;
        lastBoundsRef.current = null;
        setState({ loading: false, error: null, pointCount: 0, lastUpdate: null });
      };
    } else {
      if (layerInitRef.current) {
        abortRef.current?.abort();
        if (debounceRef.current) clearTimeout(debounceRef.current);
        removeWindParticles(map);
        layerInitRef.current = false;
        lastBoundsRef.current = null;
        clearWindCache();
        setState({ loading: false, error: null, pointCount: 0, lastUpdate: null });
      }
    }
  }, [map, enabled, fetchForViewport]);

  return state;
}
