import type { SlopeColorMode, SlopeCategory, SlopeResolutionKey } from '../types';
import { buildSlopeColorExpression, MAX_SLOPE_DEG } from './slope-config';

// ── Source & Layer IDs ────────────────────────────────────────────────

export const SLOPE_SOURCE_ID = 'slope-tiles';
export const SLOPE_LAYER_ID = 'slope-overlay';

// ── Resolution → downsample factor ────────────────────────────────────
// '0.40m (LIDAR)' is the native LIDAR resolution (no downsampling). The
// other options instruct the SW to box-average the elevation grid before
// computing slope, producing a coarser/smoother look.
const RESOLUTION_FACTOR: Record<SlopeResolutionKey, number> = {
  '0.40m (LIDAR)': 1,
  '1m': 2,
  '5m': 8,
  '10m': 16,
};

export function resolutionToFactor(res: SlopeResolutionKey | undefined): number {
  if (!res) return 1;
  return RESOLUTION_FACTOR[res] ?? 1;
}

// ── Raster source definition ──────────────────────────────────────────
//
// Tile URL only varies on `resFactor` (the only parameter that actually
// changes the slope numbers). Color mode, category breakpoints and
// band-visibility are applied GPU-side via raster-color paint properties,
// so changing them never invalidates the SW tile cache and never refetches
// any tile — `setPaintProperty` is instant and synchronous on the GPU.

export function buildSlopeTileSource(resolutionFactor: number = 1) {
  const resQuery = resolutionFactor > 1 ? `?res=${resolutionFactor}` : '';
  return {
    type: 'raster' as const,
    tiles: [`/slope-tiles/{z}/{x}/{y}${resQuery}`],
    tileSize: 256,
    minzoom: 6,
    maxzoom: 17,
  };
}

// ── Build layer definition ────────────────────────────────────────────
//
// SW PNG encoding:
//   R = round(slopeDeg * 255 / 90)   (0° → 0, 90° → 255)
//   G = B = 0
//   A = 0 on NoData, 255 otherwise
//
// raster-color-mix decodes back to degrees: deg = R * (90 / 255)
// raster-color-range [0, 90] then normalises into [0, 1] for the
// raster-color expression (which uses degNorm = deg / 90).
//
// slot: 'top' — must match the IGN ortho layer's slot so the overlay paints
// ABOVE the orthophoto. With slot: 'middle' the ortho tiles fully occlude
// the slope raster inside France and the user sees nothing.

const SLOPE_DECODE_MIX: [number, number, number, number] = [MAX_SLOPE_DEG / 255, 0, 0, 0];
const SLOPE_DECODE_RANGE: [number, number] = [0, MAX_SLOPE_DEG];

export function buildSlopeLayer(
  opacity: number,
  colorMode: SlopeColorMode,
  categories: SlopeCategory[],
  hiddenIds?: ReadonlySet<string> | string[],
) {
  return {
    id: SLOPE_LAYER_ID,
    type: 'raster' as const,
    source: SLOPE_SOURCE_ID,
    slot: 'top',
    paint: {
      'raster-opacity': opacity,
      // Linear resampling smooths band transitions on pitched views.
      // Nearest produced blocky pixel staircases that read as data errors.
      'raster-resampling': 'linear' as const,
      'raster-fade-duration': 0,
      'raster-color-mix': SLOPE_DECODE_MIX,
      'raster-color-range': SLOPE_DECODE_RANGE,
      'raster-color': buildSlopeColorExpression(categories, colorMode, hiddenIds),
    },
  };
}

// Re-exported so callers (the hook) can rebuild just the color expression
// when category/mode/hidden state changes without touching the source.
export { buildSlopeColorExpression };
