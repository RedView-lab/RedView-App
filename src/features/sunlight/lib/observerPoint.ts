import type { Map as MapboxMap } from 'mapbox-gl';

export interface SunObserverPoint {
  lng: number;
  lat: number;
  elevation: number;
}

const LNG_LAT_EPSILON = 1e-6;
const ELEVATION_EPSILON_METERS = 0.25;

export function resolveSunObserverPoint(map: MapboxMap): SunObserverPoint | null {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;

  let lng = map.getCenter().lng;
  let lat = map.getCenter().lat;

  if (width > 0 && height > 0) {
    try {
      const projected = map.unproject([width / 2, height / 2]);
      lng = projected.lng;
      lat = projected.lat;
    } catch {
      // Fall back to Mapbox's logical center if the screen-center unproject fails.
    }
  }

  const elevation = map.queryTerrainElevation?.([lng, lat]) ?? 0;
  return { lng, lat, elevation: Number.isFinite(elevation) ? elevation : 0 };
}

export function sameSunObserverPoint(
  left: SunObserverPoint | null,
  right: SunObserverPoint | null,
): boolean {
  if (!left || !right) return false;
  return Math.abs(left.lng - right.lng) <= LNG_LAT_EPSILON
    && Math.abs(left.lat - right.lat) <= LNG_LAT_EPSILON
    && Math.abs(left.elevation - right.elevation) <= ELEVATION_EPSILON_METERS;
}
