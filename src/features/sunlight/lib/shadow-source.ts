/**
 * Shadow overlay — Mapbox raster layer definitions for DEM-based shadows.
 *
 * Encoding (from shadow.js service worker):
 *   R = shadow factor: 0 = fully lit, 255 = fully shadowed
 *   G = B = 0
 *   A = 0 on NoData, 255 otherwise
 *
 * Decoding via raster-color-mix: value = R_norm * 1.0  →  [0, 1]
 * raster-color maps 0 → transparent, 1 → dark shadow.
 */

// ── Source & Layer IDs ────────────────────────────────────────────────

export const SHADOW_SOURCE_ID = 'shadow-tiles';
export const SHADOW_LAYER_ID  = 'shadow-overlay';

// ── Raster source (re-created when sun position changes) ──────────────

export function buildShadowTileSource(sunAzDeg: number, sunAltDeg: number) {
  const az = sunAzDeg.toFixed(1);
  const alt = sunAltDeg.toFixed(1);
  return {
    type: 'raster' as const,
    tiles: [`/shadow-tiles/{z}/{x}/{y}?az=${az}&alt=${alt}`],
    tileSize: 256,
    minzoom: 6,
    maxzoom: 17,
  };
}

// ── Layer definition ──────────────────────────────────────────────────
//
// The raster-color expression turns the R-channel shadow factor into a
// semi-transparent dark overlay. 0 (lit) → transparent, 1 (shadow) → black
// at the configured opacity.

const SHADOW_DECODE_MIX: [number, number, number, number] = [1, 0, 0, 0];
const SHADOW_DECODE_RANGE: [number, number] = [0, 1];

export function buildShadowLayer(opacity: number) {
  return {
    id: SHADOW_LAYER_ID,
    type: 'raster' as const,
    source: SHADOW_SOURCE_ID,
    slot: 'top',
    paint: {
      'raster-opacity': opacity,
      'raster-resampling': 'linear' as const,
      'raster-fade-duration': 150,
      'raster-color-mix': SHADOW_DECODE_MIX,
      'raster-color-range': SHADOW_DECODE_RANGE,
      'raster-color': [
        'interpolate',
        ['linear'],
        ['raster-value'],
        0,    'rgba(0, 0, 0, 0)',      // fully lit → transparent
        0.15, 'rgba(0, 0, 0, 0)',      // small threshold to avoid noise
        0.4,  'rgba(0, 0, 20, 0.35)',  // penumbra — soft partial shadow
        1,    'rgba(0, 0, 30, 0.7)',   // full shadow → dark blue-black
      ],
    },
  };
}
