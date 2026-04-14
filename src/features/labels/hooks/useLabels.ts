import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { LabelCategory } from '../types';
import { LABEL_CATEGORIES } from '../lib/label-config';

// ── Apply visibility for a single category ────────────────────────────

function applyCategory(
  map: MapboxMap,
  cat: (typeof LABEL_CATEGORIES)[number],
  visible: boolean,
) {
  const { mapping } = cat;

  if (mapping.type === 'config') {
    const keys = Array.isArray(mapping.configKey) ? mapping.configKey : [mapping.configKey];
    for (const key of keys) {
      try {
        map.setConfigProperty('basemap', key, visible);
      } catch {
        // Config property may not exist on current style variant
      }
    }
    return;
  }

  // Layer-based: enumerate all style layers matching the pattern
  try {
    const style = map.getStyle();
    if (!style?.layers) return;

    const value = visible ? 'visible' : 'none';
    for (const layer of style.layers) {
      if (mapping.pattern.test(layer.id)) {
        map.setLayoutProperty(layer.id, 'visibility', value);
      }
    }
  } catch {
    // Style may be loading
  }
}

// ── Apply all categories at once ──────────────────────────────────────

function applyAll(map: MapboxMap, state: Record<LabelCategory, boolean>) {
  for (const cat of LABEL_CATEGORIES) {
    applyCategory(map, cat, state[cat.id]);
  }
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useLabels(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  labelState: Record<LabelCategory, boolean>,
) {
  const stateRef = useRef(labelState);
  stateRef.current = labelState;

  // Apply label state whenever it changes
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    applyAll(map, labelState);
  }, [map, isMapLoaded, labelState]);

  // Re-apply after style.load (style resets wipe config properties)
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      // Defer to let useMap's init handler finish (addSource, terrain, etc.)
      setTimeout(() => {
        applyAll(map, stateRef.current);
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => {
      map.off('style.load', onStyleLoad);
    };
  }, [map, isMapLoaded]);
}
