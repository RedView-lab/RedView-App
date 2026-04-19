import type { SlopeColorMode } from '../types';
import type { SlopeCategory, SlopeResolutionKey } from '../types';

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

/**
 * Encodes dynamic color stops into the tile URL so the service worker
 * can build its LUT dynamically. Format: "0:2DBF8C,45:5C0000,90:5C0000"
 */
function encodeColorStops(categories: SlopeCategory[]): string {
  return categories.map(c => `${c.minDeg}:${c.color.replace('#', '')}`).join(',');
}

/**
 * `hiddenRanges` is an optional list of `[minDeg, maxDeg)` bands that must be
 * rendered fully transparent by the service worker. Used by the Control
 * Panel to let the user hide a specific slope category (e.g. "masquer tout
 * ce qui est plat / vert"). The ranges are baked into the tile URL so the
 * SW can honour them without any client-side post-processing.
 */
export function buildSlopeTileSource(
  colorMode: SlopeColorMode,
  hiddenRanges?: [number, number][],
  categories?: SlopeCategory[],
  resolutionFactor: number = 1,
) {
  const hideQuery = hiddenRanges && hiddenRanges.length
    ? `&hide=${hiddenRanges.map(([a, b]) => `${a}-${b}`).join(',')}`
    : '';
  const stopsQuery = categories && categories.length
    ? `&stops=${encodeColorStops(categories)}`
    : '';
  const resQuery = resolutionFactor > 1 ? `&res=${resolutionFactor}` : '';
  return {
    type: 'raster' as const,
    tiles: [`/slope-tiles/{z}/{x}/{y}?mode=${colorMode}${hideQuery}${stopsQuery}${resQuery}`],
    tileSize: 256,
    minzoom: 6,
    maxzoom: 17,
  };
}

// ── Build layer definition ────────────────────────────────────────────
// Colors are pre-rendered in the service worker PNG — no raster-color decode needed.
// slot: 'top' — must match the IGN ortho layer's slot so the overlay paints
// ABOVE the orthophoto. With slot: 'middle' the ortho tiles fully occlude
// the slope raster inside France and the user sees nothing.

export function buildSlopeLayer(opacity: number) {
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
    },
  };
}
