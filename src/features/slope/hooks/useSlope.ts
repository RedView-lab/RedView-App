import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { SlopeColorMode, SlopeCategory } from '../types';
import {
  SLOPE_SOURCE_ID,
  SLOPE_LAYER_ID,
  buildSlopeTileSource,
  buildSlopeLayer,
} from '../lib/slope-source';

// ── Helpers ───────────────────────────────────────────────────────────

// DEBUG: expose cache-clear utility in DevTools console
// Usage: window.__clearSlopeCache() → clears slope tile cache, forces fresh generation
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clearSlopeCache = () => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_SLOPE_CACHE' });
    console.log('[slope][debug] Sent CLEAR_SLOPE_CACHE to service worker. Reload the map to see fresh tiles.');
  };
}

function addSlopeLayer(
  map: MapboxMap,
  opacity: number,
  colorMode: SlopeColorMode,
  hiddenRanges?: [number, number][],
  categories?: SlopeCategory[],
) {
  if (map.getSource(SLOPE_SOURCE_ID)) {
    console.log('[slope][map] source already exists, skipping addSlopeLayer');
    return;
  }

  map.addSource(SLOPE_SOURCE_ID, buildSlopeTileSource(colorMode, hiddenRanges, categories));

  const layer = buildSlopeLayer(opacity);
  map.addLayer(layer as Parameters<MapboxMap['addLayer']>[0]);

  console.log(
    `[slope][map] %c LAYER ADDED %c source=${SLOPE_SOURCE_ID} layer=${SLOPE_LAYER_ID} opacity=${opacity} colorMode=${colorMode} stops=${categories?.length ?? '?'} slot=top`,
    'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', ''
  );
  console.log('[slope][map] paint:', JSON.stringify(layer.paint, null, 2));
}

function removeSlopeLayer(map: MapboxMap) {
  try {
    if (map.getLayer(SLOPE_LAYER_ID)) map.removeLayer(SLOPE_LAYER_ID);
    if (map.getSource(SLOPE_SOURCE_ID)) map.removeSource(SLOPE_SOURCE_ID);
    console.log('[slope][map] %c LAYER REMOVED %c', 'background:#FF9800;color:#fff;padding:2px 4px;border-radius:2px', '');
  } catch {
    console.warn('[slope][map] removeSlopeLayer caught error (style may be transitioning)');
  }
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useSlope(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  colorMode: SlopeColorMode,
  hiddenRanges?: [number, number][],
  categories?: SlopeCategory[],
) {
  const opacityRef = useRef(opacity);
  const colorModeRef = useRef(colorMode);
  const enabledRef = useRef(enabled);
  const hiddenRangesRef = useRef(hiddenRanges);
  const categoriesRef = useRef(categories);
  opacityRef.current = opacity;
  colorModeRef.current = colorMode;
  enabledRef.current = enabled;
  hiddenRangesRef.current = hiddenRanges;
  categoriesRef.current = categories;

  // Serialize ranges to a stable string for dependency comparison.
  const hiddenKey = hiddenRanges
    ? hiddenRanges.map(([a, b]) => `${a}-${b}`).join(',')
    : '';

  // Serialize categories to a stable string for dependency comparison.
  const categoriesKey = categories
    ? categories.map(c => `${c.minDeg}:${c.color}`).join(',')
    : '';

  // Add / remove layer when enabled changes
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (enabled) {
      addSlopeLayer(map, opacity, colorMode, hiddenRanges, categories);
    } else {
      removeSlopeLayer(map);
    }

    return () => {
      if (map.getStyle()) removeSlopeLayer(map);
    };
  }, [map, isMapLoaded, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update opacity when it changes
  useEffect(() => {
    if (!map || !isMapLoaded || !enabled) return;
    try {
      if (map.getLayer(SLOPE_LAYER_ID)) {
        map.setPaintProperty(SLOPE_LAYER_ID, 'raster-opacity', opacity);
      }
    } catch { /* layer may not exist yet */ }
  }, [map, isMapLoaded, enabled, opacity]);

  // Update color mode, hidden-bands, or categories — must rebuild source with new tile URL
  useEffect(() => {
    if (!map || !isMapLoaded || !enabled) return;
    try {
      if (map.getSource(SLOPE_SOURCE_ID)) {
        removeSlopeLayer(map);
        addSlopeLayer(map, opacity, colorMode, hiddenRanges, categories);
        console.log(`[slope][map] %c SOURCE REBUILT %c colorMode=${colorMode} stops=${categories?.length ?? '?'} hidden=${hiddenKey || '∅'}`, 'background:#9C27B0;color:#fff;padding:2px 4px;border-radius:2px', '');
      }
    } catch { /* layer may not exist yet */ }
  }, [map, isMapLoaded, enabled, colorMode, hiddenKey, categoriesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-add layer after style reload
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      setTimeout(() => {
        if (enabledRef.current) {
          console.log('[slope][map] %c STYLE RELOAD %c re-adding slope layer', 'background:#2196F3;color:#fff;padding:2px 4px;border-radius:2px', '');
          addSlopeLayer(map, opacityRef.current, colorModeRef.current, hiddenRangesRef.current, categoriesRef.current);
        }
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => { map.off('style.load', onStyleLoad); };
  }, [map, isMapLoaded]);
}
