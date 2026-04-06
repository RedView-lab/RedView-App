import type { WindPoint, WindCacheEntry } from '../types';
import { coordCacheKey } from './wind-grid';

// ── Configuration ─────────────────────────────────────────────────────

const API_BASE = 'https://api.open-meteo.com/v1/forecast';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const BATCH_SIZE = 50; // Max coordinates per request

// ── In-memory cache ───────────────────────────────────────────────────

const cache = new Map<string, WindCacheEntry>();

function getCached(lat: number, lng: number): WindPoint | null {
  const key = coordCacheKey(lat, lng);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.point;
}

function setCache(point: WindPoint): void {
  const key = coordCacheKey(point.lat, point.lng);
  cache.set(key, { point, fetchedAt: Date.now() });
}

// ── API fetch ─────────────────────────────────────────────────────────

interface OpenMeteoResponse {
  latitude: number | number[];
  longitude: number | number[];
  current: {
    wind_speed_10m: number;
    wind_direction_10m: number;
    wind_gusts_10m: number;
  };
}

/**
 * Fetch a single batch of wind data (up to BATCH_SIZE coordinates).
 */
async function fetchBatch(
  coords: { lat: number; lng: number }[],
  signal?: AbortSignal,
): Promise<WindPoint[]> {
  const lats = coords.map((c) => c.lat.toFixed(4)).join(',');
  const lngs = coords.map((c) => c.lng.toFixed(4)).join(',');

  const url =
    `${API_BASE}?latitude=${lats}&longitude=${lngs}` +
    `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&wind_speed_unit=ms&timeformat=unixtime&cell_selection=nearest`;

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${res.statusText}`);

  const json = await res.json();

  // Single coordinate → response is an object; multiple → array
  const items: OpenMeteoResponse[] = Array.isArray(json) ? json : [json];

  return items.map((item) => {
    const lat = Array.isArray(item.latitude) ? item.latitude[0] : item.latitude;
    const lng = Array.isArray(item.longitude) ? item.longitude[0] : item.longitude;
    return {
      lat,
      lng,
      speed: item.current.wind_speed_10m,
      direction: item.current.wind_direction_10m,
      gusts: item.current.wind_gusts_10m,
    };
  });
}

/**
 * Fetch wind data for a list of coordinates.
 * Uses in-memory cache with 15-min TTL and batches API calls.
 * Supports cancellation via AbortSignal.
 */
export async function fetchWindData(
  coords: { lat: number; lng: number }[],
  signal?: AbortSignal,
): Promise<WindPoint[]> {
  const results: WindPoint[] = [];
  const uncached: { lat: number; lng: number }[] = [];

  // 1. Check cache first
  for (const c of coords) {
    const cached = getCached(c.lat, c.lng);
    if (cached) {
      results.push(cached);
    } else {
      uncached.push(c);
    }
  }

  if (uncached.length === 0) return results;

  // 2. Batch fetch uncached coordinates
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const batch = uncached.slice(i, i + BATCH_SIZE);
    const points = await fetchBatch(batch, signal);

    for (const p of points) {
      setCache(p);
      results.push(p);
    }
  }

  return results;
}

/**
 * Clear the wind data cache.
 */
export function clearWindCache(): void {
  cache.clear();
}
