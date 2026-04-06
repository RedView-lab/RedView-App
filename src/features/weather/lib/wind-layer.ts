import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindPoint } from '../types';
import { WindCanvas } from './wind-canvas';
import { buildWindTexture } from './wind-texture';

// ── Module-level singleton ────────────────────────────────────────────

let windCanvas: WindCanvas | null = null;

// ── Public API ────────────────────────────────────────────────────────

/** Initialize the WebGL particle canvas overlay on the map */
export function initWindParticles(map: MapboxMap): void {
  if (windCanvas) return; // already initialized
  try {
    windCanvas = new WindCanvas(map);
  } catch (e) {
    console.error('[wind] WebGL particle init failed:', e);
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
  if (!windCanvas) return;
  const windData = buildWindTexture(sparsePoints, bounds);
  windCanvas.setWind(windData);
}

/** Pause the particle animation (call during map pan/zoom) */
export function pauseWindParticles(): void {
  windCanvas?.stop();
}

/** Resume the particle animation (call after map pan/zoom ends) */
export function resumeWindParticles(): void {
  windCanvas?.resume();
}

/** Remove the particle canvas and release all GPU resources */
export function removeWindParticles(): void {
  if (windCanvas) {
    windCanvas.destroy();
    windCanvas = null;
  }
}
