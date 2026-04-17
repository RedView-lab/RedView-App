import type { SlopeColorMode } from '../types';

// ── Source & Layer IDs ────────────────────────────────────────────────

export const SLOPE_SOURCE_ID = 'slope-tiles';
export const SLOPE_LAYER_ID = 'slope-overlay';

// ── Raster source definition ──────────────────────────────────────────

export function buildSlopeTileSource(colorMode: SlopeColorMode) {
  return {
    type: 'raster' as const,
    tiles: [`/slope-tiles/{z}/{x}/{y}?mode=${colorMode}`],
    // tileSize 256 matches the SW output; the previous 512 forced Mapbox
    // to request one tile and display it at 2× on-screen, blurring the
    // pre-coloured band boundaries.
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
