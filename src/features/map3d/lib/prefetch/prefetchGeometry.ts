import type { Map as MapboxMap, Point as MapboxPoint } from 'mapbox-gl';

export const PREFETCH_MIN_ZOOM = 10;
export const PREFETCH_MAX_ZOOM = 17;
export const PREFETCH_RING = 1;
export const PREFETCH_RING_TILTED = 2;
export const PREFETCH_MAX_PER_CYCLE = 48;
export const PREFETCH_THROTTLE_MS = 600;
export const PREFETCH_POST_IDLE_DELAY_MS = 400;
export const PITCH_FOREGROUND_THRESHOLD_DEG = 25;
export const TELEPORT_TILE_DELTA = 8;
export const PREDICTIVE_LEAD_TILES = 3;

export type PriorityHintInit = RequestInit & { priority?: 'high' | 'low' | 'auto' };

/**
 * Convertit des coordonnées (lng, lat) en tuile WebMercator (x, y) pour un niveau de zoom z.
 */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 1 << z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  const cap = n - 1;
  return {
    x: Math.max(0, Math.min(cap, x)),
    y: Math.max(0, Math.min(cap, y)),
  };
}

/**
 * Dé-projette un point écran (pixel) en coordonnées géographiques (lng, lat) de manière résiliente.
 */
export function screenToLngLat(
  map: MapboxMap,
  x: number,
  y: number,
): { lng: number; lat: number } | null {
  try {
    const point = { x, y } as MapboxPoint;
    const ll = map.unproject(point);
    if (!ll || !Number.isFinite(ll.lng) || !Number.isFinite(ll.lat)) return null;
    return { lng: ll.lng, lat: ll.lat };
  } catch {
    return null;
  }
}
