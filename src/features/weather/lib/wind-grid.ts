import type { WindGridConfig } from '../types';

// ── Zoom → grid spacing mapping ───────────────────────────────────────
// Lower zoom = wider spacing (fewer points cover large area)
// Higher zoom = tighter spacing (more detail in small area)
// Target: ~20-40 points visible at any zoom level

const SPACING_TABLE: [number, number][] = [
  [4, 3.0],
  [5, 2.0],
  [6, 1.0],
  [7, 0.5],
  [8, 0.25],
  [9, 0.15],
  [10, 0.08],
  [11, 0.05],
  [12, 0.03],
  [13, 0.02],
  [14, 0.01],
];

const MIN_SPACING = 0.005;
const MAX_POINTS = 100; // up to 2 API batches of 50 for higher density

/**
 * Get grid spacing (degrees) for a given zoom level.
 * Interpolates between table entries for smooth transitions.
 */
function spacingForZoom(zoom: number): number {
  if (zoom <= SPACING_TABLE[0][0]) return SPACING_TABLE[0][1];

  for (let i = 1; i < SPACING_TABLE.length; i++) {
    const [z1, s1] = SPACING_TABLE[i - 1];
    const [z2, s2] = SPACING_TABLE[i];
    if (zoom <= z2) {
      const t = (zoom - z1) / (z2 - z1);
      return s1 + t * (s2 - s1);
    }
  }

  return MIN_SPACING;
}

/**
 * Round a coordinate to the nearest grid step.
 * This ensures cache consistency when viewport shifts slightly.
 */
function snapToGrid(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Compute a grid of lat/lng sample points covering the given map bounds.
 * Returns coordinates snapped to a regular grid for cache-friendly lookups.
 */
export function computeWindGrid(
  bounds: { north: number; south: number; east: number; west: number },
  zoom: number,
): { lat: number; lng: number }[] {
  const spacing = spacingForZoom(zoom);

  const config: WindGridConfig = {
    south: snapToGrid(bounds.south, spacing),
    north: snapToGrid(bounds.north, spacing),
    west: snapToGrid(bounds.west, spacing),
    east: snapToGrid(bounds.east, spacing),
    spacing,
  };

  let currentSpacing = config.spacing;

  // Iteratively widen spacing until point count fits within MAX_POINTS
  // (avoids unbounded recursion when bounds are large at low zoom)
  for (let attempt = 0; attempt < 10; attempt++) {
    const latSteps = Math.floor((config.north - config.south) / currentSpacing) + 1;
    const lngSteps = Math.floor((config.east - config.west) / currentSpacing) + 1;
    if (latSteps * lngSteps <= MAX_POINTS) break;
    currentSpacing *= Math.sqrt((latSteps * lngSteps) / MAX_POINTS) * 1.05;
  }

  const points: { lat: number; lng: number }[] = [];
  const snappedSouth = snapToGrid(bounds.south, currentSpacing);
  const snappedWest = snapToGrid(bounds.west, currentSpacing);

  for (let lat = snappedSouth; lat <= config.north; lat += currentSpacing) {
    for (let lng = snappedWest; lng <= config.east; lng += currentSpacing) {
      const clampedLat = Math.max(-90, Math.min(90, Math.round(lat * 1e6) / 1e6));
      const clampedLng = Math.max(-180, Math.min(180, Math.round(lng * 1e6) / 1e6));
      points.push({ lat: clampedLat, lng: clampedLng });
      if (points.length >= MAX_POINTS) break;
    }
    if (points.length >= MAX_POINTS) break;
  }

  return points;
}

/**
 * Create a stable cache key for a coordinate pair (rounded to grid precision).
 */
export function coordCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}
