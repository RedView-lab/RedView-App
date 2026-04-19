import { useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { SlopeColorMode, SlopeCategory } from '../types';
import {
  SLOPE_SOURCE_ID,
  SLOPE_LAYER_ID,
  buildSlopeTileSource,
  buildSlopeLayer,
  buildSlopeColorExpression,
} from '../lib/slope-source';

// ── DevTools helper: clear slope cache ────────────────────────────────
// Usage: window.__clearSlopeCache() in DevTools, then reload the map.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clearSlopeCache = () => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_SLOPE_CACHE' });
    // eslint-disable-next-line no-console
    console.log('[slope][debug] CLEAR_SLOPE_CACHE sent — reload to fetch fresh tiles.');
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function hiddenIdsFromRanges(
  hiddenRanges: ReadonlyArray<readonly [number, number]> | undefined,
  categories: SlopeCategory[] | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!hiddenRanges?.length || !categories?.length) return out;
  for (const cat of categories) {
    for (const [a, b] of hiddenRanges) {
      // Match by exact band range — the panel hides whole categories.
      if (cat.minDeg === a && cat.maxDeg === b) {
        out.add(cat.id);
        break;
      }
    }
  }
  return out;
}

function addSlopeLayer(
  map: MapboxMap,
  opacity: number,
  colorMode: SlopeColorMode,
  categories: SlopeCategory[],
  hiddenIds: Set<string>,
  resolutionFactor: number,
) {
  if (map.getSource(SLOPE_SOURCE_ID)) return;
  map.addSource(SLOPE_SOURCE_ID, buildSlopeTileSource(resolutionFactor));
  const layer = buildSlopeLayer(opacity, colorMode, categories, hiddenIds);
  map.addLayer(layer as Parameters<MapboxMap['addLayer']>[0]);
}

function removeSlopeLayer(map: MapboxMap) {
  try {
    if (map.getLayer(SLOPE_LAYER_ID)) map.removeLayer(SLOPE_LAYER_ID);
    if (map.getSource(SLOPE_SOURCE_ID)) map.removeSource(SLOPE_SOURCE_ID);
  } catch {
    /* style may be transitioning — safe to ignore */
  }
}

// ── Hook ──────────────────────────────────────────────────────────────
//
// Update model (this is what makes UI changes feel instant):
//
//   ┌──────────────────────────┬────────────────────────────────────────┐
//   │ Change                    │ Action                                 │
//   ├──────────────────────────┼────────────────────────────────────────┤
//   │ enabled toggle            │ add / remove layer                     │
//   │ opacity                   │ setPaintProperty('raster-opacity')      │
//   │ colorMode                 │ setPaintProperty('raster-color')        │
//   │ categories (breakpoints,  │ setPaintProperty('raster-color')        │
//   │   colors, count)          │                                         │
//   │ hidden bands              │ setPaintProperty('raster-color')        │
//   │ resolution                │ rebuild source (real data change)       │
//   │ style.load                │ re-add layer with current state         │
//   └──────────────────────────┴────────────────────────────────────────┘
//
// The SW caches a single PNG per (z, x, y, resFactor). Color/mode/hide
// changes never touch the SW cache and never refetch a tile.

export function useSlope(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  colorMode: SlopeColorMode,
  hiddenRanges?: ReadonlyArray<readonly [number, number]>,
  categories?: SlopeCategory[],
  resolutionFactor: number = 1,
) {
  // Memoise the hidden-ids set so dependent effects compare a stable value.
  const hiddenIds = useMemo(
    () => hiddenIdsFromRanges(hiddenRanges, categories),
    [hiddenRanges, categories],
  );

  // Stable hash of category breakpoints + colors so we only rebuild paint
  // when something actually changes (not on every parent re-render).
  const categoriesKey = useMemo(
    () => (categories ?? []).map((c) => `${c.id}:${c.minDeg}-${c.maxDeg}:${c.color}`).join('|'),
    [categories],
  );

  // Stable hash of hidden ids.
  const hiddenKey = useMemo(
    () => Array.from(hiddenIds).sort().join(','),
    [hiddenIds],
  );

  // Refs for values needed inside style.load / mount callbacks.
  const opacityRef = useRef(opacity);
  const colorModeRef = useRef(colorMode);
  const enabledRef = useRef(enabled);
  const categoriesRef = useRef(categories);
  const hiddenIdsRef = useRef(hiddenIds);
  const resolutionFactorRef = useRef(resolutionFactor);
  opacityRef.current = opacity;
  colorModeRef.current = colorMode;
  enabledRef.current = enabled;
  categoriesRef.current = categories;
  hiddenIdsRef.current = hiddenIds;
  resolutionFactorRef.current = resolutionFactor;

  // ── 1. Toggle: add / remove layer ────────────────────────────────────
  // Also rebuilds when resolution changes (only data-affecting parameter).
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (enabled) {
      // If a previous source exists with a stale resolution, swap it out.
      if (map.getSource(SLOPE_SOURCE_ID)) removeSlopeLayer(map);
      addSlopeLayer(
        map,
        opacityRef.current,
        colorModeRef.current,
        categoriesRef.current ?? [],
        hiddenIdsRef.current,
        resolutionFactor,
      );
    } else {
      removeSlopeLayer(map);
    }

    return () => {
      if (map.getStyle()) removeSlopeLayer(map);
    };
  }, [map, isMapLoaded, enabled, resolutionFactor]);

  // ── 2. Opacity → instant ─────────────────────────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded || !enabled) return;
    try {
      if (map.getLayer(SLOPE_LAYER_ID)) {
        map.setPaintProperty(SLOPE_LAYER_ID, 'raster-opacity', opacity);
      }
    } catch {
      /* layer may not exist yet */
    }
  }, [map, isMapLoaded, enabled, opacity]);

  // ── 3. Color expression (mode / categories / hidden) → instant ───────
  // No source rebuild, no tile refetch. Mapbox swaps the GPU shader uniform
  // and the next frame already shows the new colors.
  useEffect(() => {
    if (!map || !isMapLoaded || !enabled) return;
    if (!categories?.length) return;
    try {
      if (map.getLayer(SLOPE_LAYER_ID)) {
        const expr = buildSlopeColorExpression(categories, colorMode, hiddenIds);
        // Mapbox typings expose ExpressionSpecification as a tuple union; the
        // dynamically-built expression is structurally valid but TS can't
        // narrow it, so we widen via `unknown` here.
        map.setPaintProperty(
          SLOPE_LAYER_ID,
          'raster-color',
          expr as unknown as string,
        );
      }
    } catch {
      /* layer may not exist yet */
    }
    // categoriesKey + hiddenKey provide stable dependency identity;
    // colorMode is a primitive.
  }, [map, isMapLoaded, enabled, colorMode, categoriesKey, hiddenKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 4. Style reload: re-add the layer with current state ─────────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      // Defer to the next tick so style.load completes before we touch it.
      setTimeout(() => {
        if (!enabledRef.current) return;
        addSlopeLayer(
          map,
          opacityRef.current,
          colorModeRef.current,
          categoriesRef.current ?? [],
          hiddenIdsRef.current,
          resolutionFactorRef.current,
        );
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => { map.off('style.load', onStyleLoad); };
  }, [map, isMapLoaded]);
}