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
    /* style may be transitioning */
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
    /* layer may not exist yet */
  }
}

// ── Slope active-state notification (2026-06-20 multicore pass) ───────
// Tells the SW whether slope is on/off so it can grow/shrink the in-memory
// DEM hot tier. The slope pipeline reads ~5× more DEM tiles than the
// basemap (own + 4 cardinal neighbours per slope tile), so when slope is
// active the DEM LRU needs extra headroom to avoid evicting basemap DEM
// tiles the user will re-ask for next frame. Idempotent + best-effort.
export function notifySlopeActiveState(active: boolean): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'SLOPE_ACTIVE_STATE',
      active,
    });
  } catch {
    /* service worker may not control this page yet */
  }
}

// Cheap guard — called from high-frequency map events, so it must NOT use
// map.getStyle() (serialises the whole style on every call). getTerrain /
// getSource throw while no style is attached, which the catch maps to false.
export function canStartSlopeWork(map: MapboxMap): boolean {
  try {
    return Boolean(map.getTerrain()?.source || map.getSource(SLOPE_SOURCE_ID));
  } catch {
    return false;
  }
}