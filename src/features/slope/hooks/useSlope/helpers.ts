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

export function cancelSlopeWorkerPressure(): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CANCEL_SLOPE_WORK' });
  } catch {
    /* service worker may not control this page yet */
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

// ── Viewport slope prewarm ────────────────────────────────────────────
// Asks the SW to build slope tiles for `tiles` in the given profile in the
// background. Used for:
//   * Cross-profile warming on resolution switch (build the OTHER profile
//     while the user is still looking at the current one, so the actual
//     toggle is a cache hit).
//   * Initial dual-profile warm when slope turns on (build both default +
//     terrain so the user can flip between 0.40m / 1m instantly).
//
// `profile`: 'default' (0.40m surface) | 'terrain' (1m bare-earth).
// `tiles`: array of { z, x, y }. The SW caps the batch at 64 itself.
// `zoneHash`: analysis-zone hash when the slope source is zone-bounded — the
// warms must target the same `?zone=` cache keys Mapbox will actually request.
export function prewarmSlopeViewport(
  tiles: ReadonlyArray<{ z: number; x: number; y: number }>,
  profile: 'default' | 'terrain',
  zoneHash?: string | null,
): void {
  if (!tiles.length) return;
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'PREWARM_SLOPE',
      profile,
      zone: zoneHash || '',
      tiles: tiles.slice(0, 64).map((t) => ({ z: t.z | 0, x: t.x | 0, y: t.y | 0 })),
    });
  } catch {
    /* service worker may not control this page yet */
  }
}

// Snapshot the visible viewport's tile coords (the tiles Mapbox is actively
// rendering for the slope overlay source). Used to drive cross-profile /
// initial prewarms so the SW builds exactly the tiles the user is looking
// at, not a guessed bbox.
export function snapshotVisibleTiles(
  map: MapboxMap,
  sourceId: string,
): Array<{ z: number; x: number; y: number }> {
  try {
    const sourceCache = (map as unknown as {
      style?: {
        sourceCaches?: Record<string, { getVisibleCoordinates?: () => unknown }>;
      };
    }).style?.sourceCaches?.[sourceId];
    const coords = sourceCache?.getVisibleCoordinates?.();
    if (!Array.isArray(coords)) return [];
    const out: Array<{ z: number; x: number; y: number }> = [];
    for (const c of coords) {
      const z = (c?.z ?? c?.canonical?.z) | 0;
      const x = (c?.x ?? c?.canonical?.x) | 0;
      const y = (c?.y ?? c?.canonical?.y) | 0;
      if (Number.isFinite(z) && Number.isFinite(x) && Number.isFinite(y)) {
        out.push({ z, x, y });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function canStartSlopeWork(map: MapboxMap): boolean {
  try {
    return Boolean(map.getStyle() && (map.getTerrain()?.source || map.getSource(SLOPE_SOURCE_ID)));
  } catch {
    return false;
  }
}