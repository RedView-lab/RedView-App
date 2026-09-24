import type { Map as MapboxMap } from 'mapbox-gl';

const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Computes the speed scaling factor based on current zoom level.
 * At zoom 16, factor is 1.0. At zoom 14, factor is 4.0. At zoom 6, factor is 1024.
 * This guarantees consistent perceived movement speed across all altitudes.
 */
export function getZoomSpeedScale(zoom: number): number {
  return Math.pow(2, Math.max(0, 16 - zoom));
}

/**
 * Calculates delta latitude and delta longitude given movement vectors,
 * camera heading, speed, delta time, and current latitude.
 */
export function calculateMovementDelta(
  bearingDeg: number,
  moveX: number, // -1 = left, +1 = right
  moveY: number, // -1 = backward, +1 = forward
  speedMps: number,
  dtSec: number,
  currentLat: number,
): { deltaLng: number; deltaLat: number } {
  // Normalize vector if diagonal
  const length = Math.hypot(moveX, moveY);
  const normX = length > 0 ? moveX / length : 0;
  const normY = length > 0 ? moveY / length : 0;

  const bearingRad = (bearingDeg * Math.PI) / 180;

  // Forward unit vector in world coordinates (East, North)
  // 0° bearing = North (North = +1, East = 0)
  // 90° bearing = East (North = 0, East = +1)
  const fwdEast = Math.sin(bearingRad);
  const fwdNorth = Math.cos(bearingRad);

  // Right unit vector (90° clockwise from heading)
  const rightEast = Math.cos(bearingRad);
  const rightNorth = -Math.sin(bearingRad);

  // Total displacement in meters
  const totalEastM = (normY * fwdEast + normX * rightEast) * speedMps * dtSec;
  const totalNorthM = (normY * fwdNorth + normX * rightNorth) * speedMps * dtSec;

  // Convert meters to degrees with latitude correction
  const latRad = (currentLat * Math.PI) / 180;
  const metersPerDegLng = METERS_PER_DEGREE_LAT * Math.max(0.08, Math.cos(latRad));

  const deltaLat = totalNorthM / METERS_PER_DEGREE_LAT;
  const deltaLng = totalEastM / metersPerDegLng;

  return { deltaLng, deltaLat };
}

/**
 * Clamps pitch to allowed boundaries [min, max].
 */
export function clampPitch(pitch: number, minPitch: number, maxPitch: number): number {
  return Math.max(minPitch, Math.min(maxPitch, pitch));
}

/**
 * Normalizes bearing to [0, 360).
 */
export function normalizeBearing(bearing: number): number {
  return ((bearing % 360) + 360) % 360;
}

/**
 * Clamps coordinates to valid geographical bounds.
 */
export function clampCoordinates(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(-85, Math.min(85, lat));
  const clampedLng = ((lng + 180) % 360 + 360) % 360 - 180;
  return [clampedLng, clampedLat];
}

/**
 * Samples ground elevation from the Mapbox DEM terrain if available.
 */
export function sampleTerrainAltitudeM(map: MapboxMap | null, lng: number, lat: number): number | null {
  if (!map || typeof map.queryTerrainElevation !== 'function') return null;
  try {
    const elevation = map.queryTerrainElevation([lng, lat]);
    if (typeof elevation === 'number' && Number.isFinite(elevation)) {
      return Math.round(elevation);
    }
  } catch {
    // Terrain might be in transition or style loading
  }
  return null;
}
