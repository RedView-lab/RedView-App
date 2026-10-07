import { TERRAIN_ALIGNED_RASTER_TILE_SIZE } from '@/features/map3d/lib/sources';
import { mapboxRasterColorMix } from '@/features/map3d/lib/rasterColorMix';
import type { SlopeColorMode, SlopeCategory, SlopeDemProfile } from '../types';
import { buildSlopeColorExpression, MAX_SLOPE_DEG } from './slope-config';

// ── Source & Layer IDs ────────────────────────────────────────────────

export const SLOPE_SOURCE_ID = 'slope-tiles';
export const SLOPE_LAYER_ID = 'slope-overlay';

/** Zone restriction for the slope overlay (analysis-zone polygon). */
export interface SlopeZoneOptions {
  /** Stable hash of the polygon ring — becomes the `?zone=` cache key. */
  hash: string;
  /** [west, south, east, north] — Mapbox raster-source `bounds`. */
  bounds: [number, number, number, number];
  /** Flat [lng, lat, ...] ring coordinates for masking. */
  ring?: number[];
}

export interface SlopeTileSourceOptions {
  demProfile: SlopeDemProfile;
  resolutionFactor: number;
  zone?: SlopeZoneOptions | null;
  sourceDem?: 'fast-30m' | 'hd' | '30m';
}

const DEFAULT_SOURCE_OPTIONS: SlopeTileSourceOptions = {
  demProfile: 'default',
  resolutionFactor: 1,
};

export function buildSlopeSourceKey(options: SlopeTileSourceOptions | undefined): string {
  const resolved = options ?? DEFAULT_SOURCE_OPTIONS;
  const zoneKey = resolved.zone ? `:zone-${resolved.zone.hash}` : '';
  const sourceDemKey = resolved.sourceDem ? `:src-${resolved.sourceDem}` : '';
  return `${resolved.demProfile}:${resolved.resolutionFactor}${sourceDemKey}${zoneKey}`;
}

function resolveSlopeMaxZoom(options: SlopeTileSourceOptions): number {
  // 30m resolution (fast-30m / 30m): capped at z13 (~13.5m/px at lat 45°) to prevent stair-step oversampling
  if (options.sourceDem === 'fast-30m' || options.sourceDem === '30m') {
    return 13;
  }
  // Analysis zone: pipeline pre-computes at z14, draped seamlessly on GPU beyond
  if (options.zone) {
    return 14;
  }
  // 1m LiDAR Terrain:
  if (options.demProfile === 'terrain') {
    return 16;
  }
  // 0.40m LiDAR Surface: capped at z16 (~1.69m/px at 45° lat) to prevent WMS oversampling artifacts
  return 16;
}

// ── Raster source definition ──────────────────────────────────────────
//
// Tile URL only varies on DEM profile + `resFactor` + the analysis-zone hash
// (the parameters that actually change the slope pixels). Color mode,
// category breakpoints and band-visibility are applied GPU-side via
// raster-color paint properties, so changing them never invalidates the SW
// tile cache and never refetches any tile — `setPaintProperty` is instant
// and synchronous on the GPU.
//
// Tile pyramid: the overlay requests exactly the tiles of the 3D terrain's
// DEM pyramid (TERRAIN_ALIGNED_RASTER_TILE_SIZE, z = floor(zoom − 1)), so the
// Service Worker computes slope tile z/x/y from the DEM tile z/x/y the terrain
// mesh already loaded — no DEM of its own to build. With 256 px tiles it
// asked round(zoom + 1): 16–64× more DEM tiles than the relief on screen,
// each one an IGN build. The SW returns 512 px tiles (2× Catmull-Rom of the
// DEM-resolution slope) that Mapbox draws over 1024–2048 px.
//
// Zone mode: `bounds` stops Mapbox from requesting ANY tile outside the
// polygon bbox, and `?zone=<hash>` makes the Service Worker (a) reject
// non-intersecting tiles before any DEM fetch and (b) alpha-mask partially
// covered tiles to the exact polygon. The hash in the URL also isolates
// zone-masked tiles from unmasked ones in every cache tier.

export function buildSlopeTileSource(options: SlopeTileSourceOptions = DEFAULT_SOURCE_OPTIONS) {
  const params = new URLSearchParams();
  if (options.resolutionFactor > 1) {
    params.set('res', String(options.resolutionFactor));
  }
  if (options.demProfile === 'terrain') {
    params.set('rv-dem-profile', 'terrain');
  }
  if (options.sourceDem) {
    params.set('source-dem', options.sourceDem);
  }
  if (options.zone) {
    params.set('zone', options.zone.hash);
  }
  const query = params.toString();
  const maxzoom = resolveSlopeMaxZoom(options);
  const source: {
    type: 'raster';
    tiles: string[];
    tileSize: number;
    minzoom: number;
    maxzoom: number;
    bounds?: [number, number, number, number];
  } = {
    type: 'raster',
    tiles: [`/slope-tiles/{z}/{x}/{y}${query ? `?${query}` : ''}`],
    // Zone tiles keep the z14 pipeline's 256 px grid.
    tileSize: options.zone ? 256 : TERRAIN_ALIGNED_RASTER_TILE_SIZE,
    minzoom: 4,
    maxzoom,
  };
  if (options.zone) {
    source.bounds = options.zone.bounds;
  }
  return source;
}

// ── Build layer definition ────────────────────────────────────────────
//
// SW PNG encoding (sqrt-gamma, single channel — gray + alpha PNG, decoded
// to R = G = B):
//   R = round(sqrt(deg / 90) * 255)
//   A = 0 on NoData, 255 otherwise
//
// raster-color-mix [90, 0, 0, 0] decodes R→[0,90] perceptual units.
// The actual degree value is recovered in `buildSlopeColorExpression`,
// which transforms each stop position via `degToEncoded(deg) = sqrt(deg/90) * 90`
// so that the gradient breakpoints fall at the correct raster-value.
//
// Why single-channel: bilinear `raster-resampling: 'linear'` filters each
// PNG channel independently. The previous 16-bit RG packing produced a
// regular dot/grid moiré wherever R changed between adjacent pixels (every
// ~0.35°): the bilinear (R, G) midpoint decodes to a wildly wrong value at
// the byte boundary. With a single channel + sqrt gamma the bilinear sample
// is always a smooth interpolation of the perceptual ramp, so the overlay
// shows the raw 1 m DEM signal as a clean continuous gradient.
//
// slot: 'top' — must match the IGN ortho layer's slot so the overlay paints
// ABOVE the orthophoto. With slot: 'middle' the ortho tiles fully occlude
// the slope raster inside France and the user sees nothing.

// Mapbox's −0.29 % RGB scaling compensated (rasterColorMix.ts) so band
// breakpoints fall on the exact degree.
const SLOPE_DECODE_MIX = mapboxRasterColorMix([MAX_SLOPE_DEG, 0, 0, 0]);
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
      // Legend colours must stay exact under dusk/night scene lighting.
      'raster-emissive-strength': 1,
    },
  };
}

// Re-exported so callers (the hook) can rebuild just the color expression
// when category/mode/hidden state changes without touching the source.
export { buildSlopeColorExpression };
