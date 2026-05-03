import type { SlopeColorMode, SlopeCategory, SlopeDemProfile, SlopeResolutionKey } from '../types';
import { buildSlopeColorExpression, MAX_SLOPE_DEG } from './slope-config';

// ── Source & Layer IDs ────────────────────────────────────────────────

export const SLOPE_SOURCE_ID = 'slope-tiles';
export const SLOPE_LAYER_ID = 'slope-overlay';

export interface SlopeTileSourceOptions {
  demProfile: SlopeDemProfile;
  resolutionFactor: number;
}

const DEFAULT_SOURCE_OPTIONS: SlopeTileSourceOptions = {
  demProfile: 'default',
  resolutionFactor: 1,
};

const RESOLUTION_OPTIONS: Record<SlopeResolutionKey, SlopeTileSourceOptions> = {
  '0.40m (LIDAR SURFACE)': {
    demProfile: 'default',
    resolutionFactor: 1,
  },
  '1m (LIDAR TERRAIN)': {
    demProfile: 'terrain',
    resolutionFactor: 1,
  },
};

export function resolutionToSourceOptions(
  res: SlopeResolutionKey | undefined,
): SlopeTileSourceOptions {
  if (!res) return DEFAULT_SOURCE_OPTIONS;
  return RESOLUTION_OPTIONS[res] ?? DEFAULT_SOURCE_OPTIONS;
}

export function buildSlopeSourceKey(options: SlopeTileSourceOptions | undefined): string {
  const resolved = options ?? DEFAULT_SOURCE_OPTIONS;
  return `${resolved.demProfile}:${resolved.resolutionFactor}`;
}

// ── Raster source definition ──────────────────────────────────────────
//
// Tile URL only varies on DEM profile + `resFactor` (the parameters that
// actually change the slope numbers). Color mode, category breakpoints and
// band-visibility are applied GPU-side via raster-color paint properties,
// so changing them never invalidates the SW tile cache and never refetches
// any tile — `setPaintProperty` is instant and synchronous on the GPU.

export function buildSlopeTileSource(options: SlopeTileSourceOptions = DEFAULT_SOURCE_OPTIONS) {
  const params = new URLSearchParams();
  if (options.resolutionFactor > 1) {
    params.set('res', String(options.resolutionFactor));
  }
  if (options.demProfile === 'terrain') {
    params.set('rv-dem-profile', 'terrain');
  }
  const query = params.toString();
  return {
    type: 'raster' as const,
    tiles: [`/slope-tiles/{z}/{x}/{y}${query ? `?${query}` : ''}`],
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
//
// raster-color-mix decoding:
//   Mapbox normalises raster channel values to [0, 1] before applying the
//   mix coefficients, so for an R-encoded slope (R_byte = round(deg*255/90))
//   the decoder is:
//     decoded_deg = R_norm * 90
//                 = (R_byte / 255) * 90
//                 = original deg ✓
//   Hence mix = [90, 0, 0, 0]. (Using 90/255 here was the bug that made
//   every tile look almost entirely flat — the decoded value never exceeded
//   ~0.35° even on cliffs.)

const SLOPE_DECODE_MIX: [number, number, number, number] = [MAX_SLOPE_DEG, 0, 0, 0];
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
