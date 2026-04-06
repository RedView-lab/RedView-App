import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindPoint } from '../types';
import { WindCustomLayer, WIND_LAYER_ID } from './wind-custom-layer';
import { buildWindTexture } from './wind-texture';

// ── Module-level singleton ────────────────────────────────────────────

let windLayer: WindCustomLayer | null = null;

// ── Public API ────────────────────────────────────────────────────────

/** Add the wind particle custom layer to the map (terrain-draped) */
export function initWindParticles(map: MapboxMap): void {
  if (windLayer) return; // already initialized
  try {
    windLayer = new WindCustomLayer();
    map.addLayer(windLayer);
  } catch (e) {
    windLayer = null;
    console.error('[wind] Custom layer init failed:', e);
    throw e;
  }
}

/**
 * Build a wind texture from sparse API points and feed it to the
 * particle engine. Call this after each API fetch.
 */
export function updateWindParticles(
  _map: MapboxMap,
  sparsePoints: WindPoint[],
  bounds: { north: number; south: number; east: number; west: number },
): void {
  if (!windLayer) return;
  const windData = buildWindTexture(sparsePoints, bounds);
  windLayer.setWind(windData);
}

/** Remove the custom layer and release all GPU resources */
export function removeWindParticles(map: MapboxMap): void {
  if (windLayer) {
    if (map.getLayer(WIND_LAYER_ID)) {
      map.removeLayer(WIND_LAYER_ID);
    }
    windLayer = null;
  }
}
