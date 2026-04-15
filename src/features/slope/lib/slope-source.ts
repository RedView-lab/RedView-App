import type { SlopeColorMode } from '../types';

// ── Source & Layer IDs ────────────────────────────────────────────────

export const SLOPE_SOURCE_ID = 'slope-tiles';
export const SLOPE_LAYER_ID = 'slope-overlay';

// ── Raster source definition ──────────────────────────────────────────

export function buildSlopeTileSource(colorMode: SlopeColorMode) {
  return {
    type: 'raster' as const,
    tiles: [`/slope-tiles/{z}/{x}/{y}?mode=${colorMode}`],
    tileSize: 512,
    maxzoom: 17,
  };
}

// ── Build layer definition ────────────────────────────────────────────
// Colors are pre-rendered in the service worker PNG — no raster-color decode needed.

export function buildSlopeLayer(opacity: number) {
  return {
    id: SLOPE_LAYER_ID,
    type: 'raster' as const,
    source: SLOPE_SOURCE_ID,
    slot: 'middle',
    paint: {
      'raster-opacity': opacity,
      'raster-resampling': 'nearest' as const,
    },
  };
}
