import type { Map as MapboxMap } from 'mapbox-gl';
import type { SlopeCategory, SlopeColorMode } from '../../types';
import {
  SLOPE_LAYER_ID,
  SLOPE_SOURCE_ID,
  type SlopeTileSourceOptions,
  buildSlopeLayer,
  buildSlopeTileSource,
} from '../../lib/slope-source';

export function hiddenIdsFromRanges(
  hiddenRanges: ReadonlyArray<readonly [number, number]> | undefined,
  categories: SlopeCategory[] | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!hiddenRanges?.length || !categories?.length) return out;
  for (const category of categories) {
    for (const [minDeg, maxDeg] of hiddenRanges) {
      if (category.minDeg === minDeg && category.maxDeg === maxDeg) {
        out.add(category.id);
        break;
      }
    }
  }
  return out;
}

export function addSlopeLayer(
  map: MapboxMap,
  opacity: number,
  colorMode: SlopeColorMode,
  categories: SlopeCategory[],
  hiddenIds: Set<string>,
  sourceOptions: SlopeTileSourceOptions,
): boolean {
  try {
    if (!map.getSource(SLOPE_SOURCE_ID)) {
      map.addSource(SLOPE_SOURCE_ID, buildSlopeTileSource(sourceOptions));
    }
    if (!map.getLayer(SLOPE_LAYER_ID)) {
      const layer = buildSlopeLayer(opacity, colorMode, categories, hiddenIds);
      map.addLayer(layer as Parameters<MapboxMap['addLayer']>[0]);
    }
  } catch {
    return false;
  }
  return Boolean(map.getSource(SLOPE_SOURCE_ID) && map.getLayer(SLOPE_LAYER_ID));
}

export function removeSlopeLayer(map: MapboxMap): void {
  try {
    if (map.getLayer(SLOPE_LAYER_ID)) map.removeLayer(SLOPE_LAYER_ID);
    if (map.getSource(SLOPE_SOURCE_ID)) map.removeSource(SLOPE_SOURCE_ID);
  } catch {
    /* le style est peut-être en transition */
  }
}

export function setSlopeVisibility(map: MapboxMap, visible: boolean): void {
  try {
    if (map.getLayer(SLOPE_LAYER_ID)) {
      map.setLayoutProperty(
        SLOPE_LAYER_ID,
        'visibility',
        visible ? 'visible' : 'none',
      );
    }
  } catch {
    /* la couche n'existe peut-être pas encore */
  }
}

// ── Notification de l'état actif de la pente (passe multicœur du 2026-06-20) ──
// Indique au SW si la pente est activée ou non pour qu'il agrandisse ou
// réduise le niveau chaud en mémoire du DEM. Le pipeline de pente lit ~5× plus
// de tuiles DEM que le fond de carte (la sienne + 4 voisines cardinales par
// tuile de pente) : quand la pente est active, la LRU du DEM a besoin de marge
// pour ne pas évincer les tuiles DEM du fond que l'utilisateur redemandera à
// l'image suivante. Idempotent et au mieux.
export function notifySlopeActiveState(active: boolean): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'SLOPE_ACTIVE_STATE',
      active,
    });
  } catch {
    /* le Service Worker ne contrôle peut-être pas encore cette page */
  }
}

// Garde peu coûteuse — appelée depuis des événements de carte à haute
// fréquence, elle ne doit donc PAS utiliser map.getStyle() (qui sérialise tout
// le style à chaque appel). getTerrain / getSource lèvent une exception tant
// qu'aucun style n'est attaché, ce que le catch traduit en false.
export function canStartSlopeWork(map: MapboxMap): boolean {
  try {
    return Boolean(map.getTerrain()?.source || map.getSource(SLOPE_SOURCE_ID));
  } catch {
    return false;
  }
}