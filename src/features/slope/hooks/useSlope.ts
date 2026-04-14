import { useEffect, useRef } from 'react';
import type { Map as MapboxMap, ExpressionSpecification } from 'mapbox-gl';
import type { SlopeColorMode } from '../types';
import { buildSlopeColorExpression, SLOPE_CATEGORIES } from '../lib/slope-config';
import {
  SLOPE_SOURCE_ID,
  SLOPE_LAYER_ID,
  slopeTileSource,
  buildSlopeLayer,
} from '../lib/slope-source';

// ── Helpers ───────────────────────────────────────────────────────────

function addSlopeLayer(map: MapboxMap, opacity: number, colorMode: SlopeColorMode) {
  if (map.getSource(SLOPE_SOURCE_ID)) return;

  map.addSource(SLOPE_SOURCE_ID, slopeTileSource);

  const layer = buildSlopeLayer(opacity, colorMode);
  // Insert below symbol layers so labels stay on top
  const firstSymbol = map.getStyle()?.layers?.find(l => l.type === 'symbol');
  map.addLayer(layer as Parameters<MapboxMap['addLayer']>[0], firstSymbol?.id);
}

function removeSlopeLayer(map: MapboxMap) {
  try {
    if (map.getLayer(SLOPE_LAYER_ID)) map.removeLayer(SLOPE_LAYER_ID);
    if (map.getSource(SLOPE_SOURCE_ID)) map.removeSource(SLOPE_SOURCE_ID);
  } catch {
    // Style may be transitioning
  }
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useSlope(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  colorMode: SlopeColorMode,
) {
  const opacityRef = useRef(opacity);
  const colorModeRef = useRef(colorMode);
  const enabledRef = useRef(enabled);
  opacityRef.current = opacity;
  colorModeRef.current = colorMode;
  enabledRef.current = enabled;

  // Add / remove layer when enabled changes
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (enabled) {
      addSlopeLayer(map, opacity, colorMode);
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

  // Update color mode when it changes
  useEffect(() => {
    if (!map || !isMapLoaded || !enabled) return;
    try {
      if (map.getLayer(SLOPE_LAYER_ID)) {
        map.setPaintProperty(
          SLOPE_LAYER_ID,
          'raster-color',
          buildSlopeColorExpression(SLOPE_CATEGORIES, colorMode) as unknown as ExpressionSpecification,
        );
      }
    } catch { /* layer may not exist yet */ }
  }, [map, isMapLoaded, enabled, colorMode]);

  // Re-add layer after style reload
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      setTimeout(() => {
        if (enabledRef.current) {
          addSlopeLayer(map, opacityRef.current, colorModeRef.current);
        }
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => { map.off('style.load', onStyleLoad); };
  }, [map, isMapLoaded]);
}
