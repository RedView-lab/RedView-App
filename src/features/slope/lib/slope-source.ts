import type { SlopeColorMode } from '../types';
import { buildSlopeColorExpression, SLOPE_CATEGORIES } from './slope-config';

// ── Source & Layer IDs ────────────────────────────────────────────────

export const SLOPE_SOURCE_ID = 'slope-tiles';
export const SLOPE_LAYER_ID = 'slope-overlay';

// ── Raster source definition ──────────────────────────────────────────

export const slopeTileSource = {
  type: 'raster' as const,
  tiles: ['/slope-tiles/{z}/{x}/{y}'],
  tileSize: 512,
  maxzoom: 17,
};

// ── Build layer definition with raster-color paint ────────────────────

export function buildSlopeLayer(opacity: number, colorMode: SlopeColorMode) {
  return {
    id: SLOPE_LAYER_ID,
    type: 'raster' as const,
    source: SLOPE_SOURCE_ID,
    slot: 'middle',
    paint: {
      'raster-opacity': opacity,
      // Decode Terrain-RGB back to slope degrees:
      // value = -10000 + (R*65536 + G*256 + B) * 0.1
      'raster-color-mix': [65536 * 0.1, 256 * 0.1, 0.1, -10000] as [number, number, number, number],
      'raster-color-range': [0, 90] as [number, number],
      'raster-color': buildSlopeColorExpression(SLOPE_CATEGORIES, colorMode),
      'raster-resampling': 'nearest' as const,
    },
  };
}
