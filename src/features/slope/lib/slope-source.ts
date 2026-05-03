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
//   V = round(slopeDeg * 65535 / 90) (0° → 0, 90° → 65535)
//   R = V >> 8
//   G = V & 255
//   B = 0
//   A = 0 on NoData, 255 otherwise
//
// raster-color-mix decodes back to degrees: deg = V * (90 / 65535)
// raster-color-range [0, 90] then normalises into [0, 1] for the
// raster-color expression (which uses degNorm = deg / 90).
//
// slot: 'top' — must match the IGN ortho layer's slot so the overlay paints
// ABOVE the orthophoto. With slot: 'middle' the ortho tiles fully occlude
// the slope raster inside France and the user sees nothing.
//
// raster-color-mix decoding:
//   Mapbox normalises channels to [0, 1] before applying the mix, so with
//   V = R_byte*256 + G_byte the decoder becomes:
//     decoded_deg = (R_norm * (90*256/257)) + (G_norm * (90/257))
//                 = ((R_byte*256 + G_byte) / 65535) * 90
//                 = original deg ✓
//   Keeping the decode affine across channels means linear raster sampling
//   stays smooth while the extra precision removes visible micro-banding.

const SLOPE_DECODE_MIX: [number, number, number, number] = [
  (MAX_SLOPE_DEG * 256) / 257,
  MAX_SLOPE_DEG / 257,
  0,
  0,
];
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
