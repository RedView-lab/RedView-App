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
  const mapWithConfig = map as MapboxMap & {
    getConfigProperty?: (importId: string, configKey: string) => unknown;
  };

  const applyConfigKeys = (configKey: string | string[]) => {
    const keys = Array.isArray(configKey) ? configKey : [configKey];
    for (const key of keys) {
      try {
        const current = mapWithConfig.getConfigProperty?.('basemap', key);
        if (current === visible) continue;
        map.setConfigProperty('basemap', key, visible);
      } catch {
        // Config property may not exist on current style variant
      }
    }
  };

  const matchesLayerPattern = (layer: ReturnType<MapboxMap['getStyle']>['layers'][number], pattern: RegExp) => {
    const layerRecord = layer as Record<string, unknown>;
    const searchable = [
      layer.id,
      typeof layerRecord.source === 'string' ? layerRecord.source : '',
      typeof layerRecord['source-layer'] === 'string' ? layerRecord['source-layer'] : '',
      typeof layerRecord.slot === 'string' ? layerRecord.slot : '',
    ]
      .filter(Boolean)
      .join(' ');
    return pattern.test(searchable);
  };

  const applyMatchingLayers = (pattern: RegExp) => {
    try {
      const style = map.getStyle();
      if (!style?.layers) return;

      const value = visible ? 'visible' : 'none';
      for (const layer of style.layers) {
        if (matchesLayerPattern(layer, pattern)) {
          const current = map.getLayoutProperty(layer.id, 'visibility');
          if (current === value) continue;
          map.setLayoutProperty(layer.id, 'visibility', value);
        }
      }
    } catch {
      // Style may be loading
    }
  };

  if (mapping.type === 'config') {
    applyConfigKeys(mapping.configKey);
    return;
  }

  if (mapping.type === 'mixed') {
    applyConfigKeys(mapping.configKey);
    applyMatchingLayers(mapping.pattern);
    return;
  }

  // Layer-based: enumerate all style layers matching the pattern
  applyMatchingLayers(mapping.pattern);
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

  // Re-apply after style rebuilds. Some basemap variants keep emitting
  // styledata while imported label layers are still being attached.
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    let applyTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleApply = () => {
      if (applyTimer !== null) return;
      applyTimer = setTimeout(() => {
        applyTimer = null;
        applyAll(map, stateRef.current);
      }, 0);
    };

    const onStyleLoad = () => {
      scheduleApply();
    };

    const onStyleData = () => {
      scheduleApply();
    };

    map.on('style.load', onStyleLoad);
    map.on('styledata', onStyleData);
    return () => {
      if (applyTimer !== null) clearTimeout(applyTimer);
      map.off('style.load', onStyleLoad);
      map.off('styledata', onStyleData);
    };
  }, [map, isMapLoaded]);
}
