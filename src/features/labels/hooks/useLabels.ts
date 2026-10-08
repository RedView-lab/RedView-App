import { useEffect, useLayoutEffect, useRef } from 'react';
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

/**
 * Calques ajoutés par l'application (tracés BRouter, zones RedView, ortho IGN,
 * overlays…) : jamais touchés par les bascules d'étiquettes. Sans ces
 * préfixes, `brouter-analysis-hover-point-layer` (« point » contient « poi »)
 * était masqué par la bascule POI.
 */
export function isAppCustomLayer(layerId: string): boolean {
  return (
    layerId.startsWith('rv-') ||
    layerId.startsWith('brouter-') ||
    layerId.startsWith('redview-') ||
    layerId.startsWith('ign-') ||
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

  // Seuls les calques symbol sont des étiquettes. Les motifs ci-dessous
  // matchent des sous-chaînes (« trail » contient « rail ») : appliqués aux
  // lignes/remplissages, ils masquaient sentiers, voies ferrées, clôtures et
  // tout le réseau routier. Exception : les tracés de frontières, rattachés
  // explicitement aux catégories Pays / Régions.
  const isSymbol = layer.type === 'symbol';
  if (!isSymbol && !/(admin|boundary|border|disputed)/i.test(id)) return null;

  // 1. Pays (noms de pays et frontières nationales)
  // P. ex. "country-label", "country-label-sm", "admin-0-boundary", "admin-0-line", "boundary-land", etc.
  if (
    /(country|admin[-_]?0|boundary[-_]?(land|water)|border|disputed)/i.test(id) &&
    !/(state|province|admin[-_]?1)/i.test(id)
  ) {
    return 'countries';
  }

  // 2. États / régions (noms d'États / de provinces et limites admin-1)
  // P. ex. "state-label", "state-label-sm", "province-label", "admin-1-boundary", etc.
  if (/(state|province|admin[-_]?1)/i.test(id)) {
    return 'states';
  }

  if (!isSymbol) return null;

  // 3. Étiquettes des plans d'eau
  if (/(water.*label|waterway.*label|marine.*label|water-point-label|water-line-label)/i.test(id)) {
    return 'waterBody';
  }

  // 4. Parcs naturels / espaces protégés
  if (/(natural|park|protected|national-park)/i.test(id) && !/(water|marine)/i.test(id)) {
    return 'naturalParks';
  }

  // 5. Étiquettes des POI
  if (
    /(poi|point[-_ ]?of[-_ ]?interest|airport|aerodrome|airfield|airstrip|heliport|terminal|gate|station|transit|rail|metro|subway|tram|bus|attraction|lodging|food|hospital|school)/i.test(id)
  ) {
    return 'poi';
  }

  // 6. Routes / itinéraires
  if (
    /(road|street|highway|motorway|trunk|primary|secondary|tertiary|pedestrian|path|track|junction|shield|tunnel|bridge|traffic|railway|aerialway|aeroway|runway|taxiway)/i.test(id)
  ) {
    return 'roads';
  }

  // 7. Lieux (villes, bourgs, villages, hameaux, faubourgs, quartiers)
  // P. ex. "settlement-major-label", "settlement-minor-label", "place-city-lg", "place-town", etc.
  if (
    /(settlement|locality|city|town|village|hamlet|suburb|neighbou?rhood|district|place[-_](city|town|village|hamlet|suburb|neighbourhood|other|island|islet|locality))/i.test(id) ||
    (id.startsWith('place-') && !/(country|state|province|admin)/i.test(id))
  ) {
    return 'places';
  }

  // Repli pour la source-layer "place_label"
  const layerRecord = layer as Record<string, unknown>;
  const sourceLayer = typeof layerRecord['source-layer'] === 'string' ? layerRecord['source-layer'] : '';
  if (sourceLayer === 'place_label' || sourceLayer === 'place') {
    if (/country/i.test(id)) return 'countries';
    if (/state|province/i.test(id)) return 'states';
    return 'places';
  }

  return null;
}

// ── Masque global de toutes les étiquettes, routes et frontières ──────

function applyMasterDisable(map: MapboxMap) {
  const mapWithConfig = map as MapboxMap & {
    getConfigProperty?: (importId: string, configKey: string) => unknown;
  };

  // 1. Désactive toutes les configurations du style Standard
  for (const key of STANDARD_CONFIG_KEYS) {
    try {
      const current = mapWithConfig.getConfigProperty?.('basemap', key);
      if (current !== false) {
        map.setConfigProperty('basemap', key, false);
      }
    } catch {
      // Ignoré si ce n'est pas le style Standard
    }
  }

  // 2. Désactive toutes les couches symbol du style et toutes les couches vectorielles en surcouche
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
    // Le style est peut-être en chargement
  }
}

// ── Application de toutes les catégories d'un coup ────────────────────

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

  // 1. Synchronise les propriétés de configuration du fond Mapbox Standard
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
      // La propriété de configuration n'existe peut-être pas sur cette variante de style
    }
  };

  setConfigSafe('showPlaceLabels', hasPlaceLabels);
  setConfigSafe('showAdminBoundaries', hasAdminBoundaries);
  setConfigSafe('showPointOfInterestLabels', hasPoi);
  setConfigSafe('showTransitLabels', hasPoi);
  setConfigSafe('showRoadLabels', hasRoads);
  // Les bascules par catégorie ne concernent que les étiquettes : le réseau
  // routier reste visible (et est rétabli après un « tout masquer »).
  setConfigSafe('showRoadsAndTransit', true);
  setConfigSafe('showPedestrianRoads', true);

  // 2. Énumère toutes les couches du style et applique la visibilité par catégorie
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
    // Le style est peut-être en chargement
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
  // Dernier état commité, pour les réapplications après un rechargement de style.
  useLayoutEffect(() => {
    stateRef.current = { labelState, labelsEnabled };
  }, [labelState, labelsEnabled]);

  // Applique l'état des étiquettes à chaque changement
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    applyAll(map, labelState, labelsEnabled);
  }, [map, isMapLoaded, labelState, labelsEnabled]);

  // Réapplique après les reconstructions du style. Certaines variantes de fond
  // continuent d'émettre styledata pendant que les couches d'étiquettes
  // importées sont encore en cours d'attachement.
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
