import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindGridDefinition, WindPoint } from '../types';
import { WindCustomLayer, WIND_LAYER_ID } from './wind';
import { buildWindTexture } from './wind-texture';

// ── Module-level singleton ────────────────────────────────────────────

let windLayer: WindCustomLayer | null = null;

// ── Public API ────────────────────────────────────────────────────────

/** Add the wind particle custom layer to the map as world-space 3D particles. */
export function initWindParticles(map: MapboxMap): void {
  // If we already have a singleton AND Mapbox still has the layer, no-op.
  // After a style swap Mapbox wipes the layer but our ref survives — in
  // that case we drop the stale singleton and rebuild so callers can use
  // initWindParticles() as an idempotent recovery hook from style.load.
  if (windLayer) {
    if (map.getLayer(WIND_LAYER_ID)) return;
    windLayer = null;
  }
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
 * Build a wind texture from a regular grid and feed it to the
 * particle engine. Call this after each VPS fetch.
 */
export function updateWindParticles(
  _map: MapboxMap,
  grid: WindGridDefinition,
  points: WindPoint[],
): void {
  if (!windLayer) return;
  const windData = buildWindTexture(grid, points);
  windLayer.setWind(windData, grid.bounds);
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
