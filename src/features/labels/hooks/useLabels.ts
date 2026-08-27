import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { LabelCategory } from '../types';

const STANDARD_CONFIG_KEYS = [
  'showPointOfInterestLabels',
  'showTransitLabels',
  'showRoadLabels',
  'showPlaceLabels',
  'showAdminBoundaries',
  'showRoadsAndTransit',
  'showPedestrianRoads',
] as const;

const ALL_VECTOR_OVERLAY_PATTERN =
  /(road|street|highway|motorway|trunk|primary|secondary|tertiary|pedestrian|path|track|junction|shield|tunnel|bridge|traffic|railway|rail|transit|ferry|aerialway|aeroway|runway|taxiway|admin|boundary|border|country|state|province|poi|place|settlement|locality|natural|park|protected|water.*label|waterway.*label|marine.*label)/i;

function isAppCustomLayer(layerId: string): boolean {
  return (
    layerId.startsWith('rv-') ||
    layerId.startsWith('rvi-') ||
    layerId.startsWith('route-') ||
    layerId.startsWith('forbidden-zone-') ||
    layerId.startsWith('analysis-') ||
    layerId.startsWith('lidar-') ||
    layerId.startsWith('weather-') ||
    layerId.startsWith('wind-') ||
    layerId.startsWith('sunlight-') ||
    layerId.startsWith('sun-') ||
    layerId.startsWith('shadow-') ||
    layerId.startsWith('slope-') ||
    layerId.startsWith('altitude-') ||
    layerId.startsWith('contour-') ||
    layerId.startsWith('custom-')
  );
}

function matchesLayerPattern(
  layer: ReturnType<MapboxMap['getStyle']>['layers'][number],
  pattern: RegExp,
): boolean {
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
}

export function getLayerCategory(
  layer: ReturnType<MapboxMap['getStyle']>['layers'][number],
): LabelCategory | null {
  const id = layer.id.toLowerCase();
  if (isAppCustomLayer(id)) return null;

  // 1. Countries (Country names & country boundaries)
  // E.g. "country-label", "country-label-sm", "admin-0-boundary", "admin-0-line", "boundary-land", etc.
  if (
    /(country|admin[-_]?0|boundary[-_]?(land|water)|border|disputed)/i.test(id) &&
    !/(state|province|admin[-_]?1)/i.test(id)
  ) {
    return 'countries';
  }

  // 2. States / Regions (State / province names & admin-1 boundaries)
  // E.g. "state-label", "state-label-sm", "province-label", "admin-1-boundary", etc.
  if (/(state|province|admin[-_]?1)/i.test(id)) {
    return 'states';
  }

  // 3. Water body labels
  if (/(water.*label|waterway.*label|marine.*label|water-point-label|water-line-label)/i.test(id)) {
    return 'waterBody';
  }

  // 4. Natural parks / protected areas
  if (/(natural|park|protected|national-park)/i.test(id) && !/(water|marine)/i.test(id)) {
    return 'naturalParks';
  }

  // 5. POI labels
  if (
    /(poi|point[-_ ]?of[-_ ]?interest|airport|aerodrome|airfield|airstrip|heliport|terminal|gate|station|transit|rail|metro|subway|tram|bus|attraction|lodging|food|hospital|school)/i.test(id)
  ) {
    return 'poi';
  }

  // 6. Roads / routes
  if (
    /(road|street|highway|motorway|trunk|primary|secondary|tertiary|pedestrian|path|track|junction|shield|tunnel|bridge|traffic|railway|aerialway|aeroway|runway|taxiway)/i.test(id)
  ) {
    return 'roads';
  }

  // 7. Places (Cities, towns, villages, hamlets, suburbs, neighbourhoods)
  // E.g. "settlement-major-label", "settlement-minor-label", "place-city-lg", "place-town", etc.
  if (
    /(settlement|locality|city|town|village|hamlet|suburb|neighbou?rhood|district|place[-_](city|town|village|hamlet|suburb|neighbourhood|other|island|islet|locality))/i.test(id) ||
    (id.startsWith('place-') && !/(country|state|province|admin)/i.test(id))
  ) {
    return 'places';
  }

  // Fallback for source-layer "place_label"
  const layerRecord = layer as Record<string, unknown>;
  const sourceLayer = typeof layerRecord['source-layer'] === 'string' ? layerRecord['source-layer'] : '';
  if (sourceLayer === 'place_label' || sourceLayer === 'place') {
    if (/country/i.test(id)) return 'countries';
    if (/state|province/i.test(id)) return 'states';
    return 'places';
  }

  return null;
}

// ── Master hide all labels, roads, and boundaries ─────────────────────

function applyMasterDisable(map: MapboxMap) {
  const mapWithConfig = map as MapboxMap & {
    getConfigProperty?: (importId: string, configKey: string) => unknown;
  };

  // 1. Turn off all standard style configs
  for (const key of STANDARD_CONFIG_KEYS) {
    try {
      const current = mapWithConfig.getConfigProperty?.('basemap', key);
      if (current !== false) {
        map.setConfigProperty('basemap', key, false);
      }
    } catch {
      // Ignore if not standard style
    }
  }

  // 2. Turn off all style symbol layers and all overlay vector layers
  try {
    const style = map.getStyle();
    if (!style?.layers) return;

    for (const layer of style.layers) {
      if (isAppCustomLayer(layer.id)) continue;

      if (layer.type === 'symbol' || getLayerCategory(layer) !== null || matchesLayerPattern(layer, ALL_VECTOR_OVERLAY_PATTERN)) {
        const current = map.getLayoutProperty(layer.id, 'visibility');
        if (current !== 'none') {
          map.setLayoutProperty(layer.id, 'visibility', 'none');
        }
      }
    }
  } catch {
    // Style may be loading
  }
}

// ── Apply all categories at once ──────────────────────────────────────

function applyAll(
  map: MapboxMap,
  state: Record<LabelCategory, boolean>,
  labelsEnabled: boolean,
) {
  if (!labelsEnabled) {
    applyMasterDisable(map);
    return;
  }

  const mapWithConfig = map as MapboxMap & {
    getConfigProperty?: (importId: string, configKey: string) => unknown;
  };

  // 1. Sync Mapbox Standard basemap configuration properties
  const hasPlaceLabels = Boolean(state.places);
  const hasAdminBoundaries = Boolean(state.countries || state.states);
  const hasPoi = Boolean(state.poi);
  const hasRoads = Boolean(state.roads);

  const setConfigSafe = (key: string, value: boolean) => {
    try {
      const current = mapWithConfig.getConfigProperty?.('basemap', key);
      if (current === value) return;
      map.setConfigProperty('basemap', key, value);
    } catch {
      // Config property may not exist on current style variant
    }
  };

  setConfigSafe('showPlaceLabels', hasPlaceLabels);
  setConfigSafe('showAdminBoundaries', hasAdminBoundaries);
  setConfigSafe('showPointOfInterestLabels', hasPoi);
  setConfigSafe('showTransitLabels', hasPoi);
  setConfigSafe('showRoadLabels', hasRoads);
  setConfigSafe('showRoadsAndTransit', hasRoads);
  setConfigSafe('showPedestrianRoads', hasRoads);

  // 2. Enumerate all style layers and apply visibility per category
  try {
    const style = map.getStyle();
    if (!style?.layers) return;

    for (const layer of style.layers) {
      if (isAppCustomLayer(layer.id)) continue;

      const category = getLayerCategory(layer);
      if (category) {
        const visible = state[category] ? 'visible' : 'none';
        const current = map.getLayoutProperty(layer.id, 'visibility');
        if (current !== visible) {
          map.setLayoutProperty(layer.id, 'visibility', visible);
        }
      }
    }
  } catch {
    // Style may be loading
  }
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useLabels(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  labelState: Record<LabelCategory, boolean>,
  labelsEnabled: boolean = true,
) {
  const stateRef = useRef({ labelState, labelsEnabled });
  stateRef.current = { labelState, labelsEnabled };

  // Apply label state whenever it changes
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    applyAll(map, labelState, labelsEnabled);
  }, [map, isMapLoaded, labelState, labelsEnabled]);

  // Re-apply after style rebuilds. Some basemap variants keep emitting
  // styledata while imported label layers are still being attached.
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    let applyTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleApply = () => {
      if (applyTimer !== null) return;
      applyTimer = setTimeout(() => {
        applyTimer = null;
        applyAll(map, stateRef.current.labelState, stateRef.current.labelsEnabled);
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
