import { useRef, useEffect, useState, useCallback } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindState } from '../types';
import { computeWindGrid } from '../lib/wind-grid';
import { fetchWindData, clearWindCache } from '../lib/open-meteo';
import {
  createWindArrowIcon,
  addWindLayer,
  updateWindData,
  removeWindLayer,
} from '../lib/wind-layer';

// ── Configuration ─────────────────────────────────────────────────────

const DEBOUNCE_MS = 800;
const VIEWPORT_SHIFT_THRESHOLD = 0.15; // 15% shift → refetch
const PULSE_INTERVAL_MS = 2500;
const PULSE_MIN = 0.7;
const PULSE_MAX = 0.9;

// ── Viewport helpers ──────────────────────────────────────────────────

interface ViewportBounds {
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
}

function getViewportBounds(map: MapboxMap): ViewportBounds {
  const b = map.getBounds();
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
  const pulseRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const layerInitRef = useRef(false);

  // ── Fetch wind data for current viewport ────────────────────────

  const fetchForViewport = useCallback(
    async (m: MapboxMap) => {
      const bounds = getViewportBounds(m);

      // Skip if viewport hasn't shifted enough
      if (lastBoundsRef.current) {
        const shift = viewportShiftRatio(lastBoundsRef.current, bounds);
        const zoomDelta = Math.abs(lastBoundsRef.current.zoom - bounds.zoom);
        if (shift < VIEWPORT_SHIFT_THRESHOLD && zoomDelta < 0.5) return;
      }

      // Cancel previous request
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

        const points = await fetchWindData(grid, controller.signal);

        // Check if still mounted & not aborted
        if (controller.signal.aborted) return;

        updateWindData(m, points);
        lastBoundsRef.current = bounds;

        setState({
          loading: false,
          error: null,
          pointCount: points.length,
          lastUpdate: Date.now(),
        });
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : 'Wind fetch failed';
        console.error('[weather]', message);
        setState((s) => ({ ...s, loading: false, error: message }));
      }
    },
    [],
  );

  // ── Init / destroy layer on enable toggle ───────────────────────

  useEffect(() => {
    if (!map) return;

    if (enabled) {
      // Initialize layer
      createWindArrowIcon(map);
      addWindLayer(map);
      layerInitRef.current = true;

      // Fetch immediately
      fetchForViewport(map);

      // Listen to viewport changes
      const onMoveEnd = () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => fetchForViewport(map), DEBOUNCE_MS);
      };
      map.on('moveend', onMoveEnd);

      // Subtle opacity pulse animation
      let rising = false;
      pulseRef.current = setInterval(() => {
        if (!map.getLayer('wind-arrows')) return;
        const target = rising ? PULSE_MAX : PULSE_MIN;
        rising = !rising;
        try {
          map.setPaintProperty('wind-arrows', 'icon-opacity', target);
        } catch {
          // Layer may have been removed
        }
      }, PULSE_INTERVAL_MS);

      return () => {
        map.off('moveend', onMoveEnd);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (pulseRef.current) clearInterval(pulseRef.current);
        abortRef.current?.abort();
        removeWindLayer(map);
        layerInitRef.current = false;
        lastBoundsRef.current = null;
        setState({ loading: false, error: null, pointCount: 0, lastUpdate: null });
      };
    } else {
      // Cleanup if was enabled before
      if (layerInitRef.current) {
        abortRef.current?.abort();
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (pulseRef.current) clearInterval(pulseRef.current);
        removeWindLayer(map);
        layerInitRef.current = false;
        lastBoundsRef.current = null;
        clearWindCache();
        setState({ loading: false, error: null, pointCount: 0, lastUpdate: null });
      }
    }
  }, [map, enabled, fetchForViewport]);

  return state;
}
