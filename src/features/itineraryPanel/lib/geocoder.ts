/**
 * Lightweight wrapper around the Mapbox Geocoding v5 "places" endpoint.
 *
 * We only need forward search (text → list of suggestions) for the
 * itinerary's Départ / Fin search inputs. No reverse lookup, no session
 * tokens — keep it small.
 */

import { MAPBOX_TOKEN } from '@/features/map3d/lib/mapbox.config';

export interface GeocodeSuggestion {
  /** Mapbox feature id (used as React key). */
  id: string;
  /** Primary label, e.g. "Annecy". */
  name: string;
  /** Full place_name, e.g. "Annecy, Haute-Savoie, France". */
  fullName: string;
  /** WGS84 longitude. */
  lon: number;
  /** WGS84 latitude. */
  lat: number;
}

export interface GeocodeOptions {
  /** Bias results around this lon/lat (current map center). */
  proximity?: { lon: number; lat: number };
  /** Max number of results (Mapbox cap = 10). */
  limit?: number;
  /** ISO-639 language. Defaults to fr. */
  language?: string;
  /** ISO-3166 country filter, comma-separated, e.g. "fr,be,ch". */
  countries?: string;
  signal?: AbortSignal;
}

export interface ReverseGeocodeOptions {
  /** Max number of candidate features to inspect. */
  limit?: number;
  /** ISO-639 language. Defaults to fr. */
  language?: string;
  /** ISO-3166 country filter, comma-separated, e.g. "fr,be,ch". */
  countries?: string;
  /** Maximum distance from the query point to accept a settlement label. */
  maxDistanceMeters?: number;
  signal?: AbortSignal;
}

interface MapboxFeature {
  id: string;
  text: string;
  place_name: string;
  center: [number, number]; // [lon, lat]
  place_type?: string[];
  context?: Array<{ id: string; text: string }>;
}

interface MapboxResponse {
  features: MapboxFeature[];
}

const ENDPOINT = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

// ---------------------------------------------------------------------------
// Production hardening: small in-memory LRU cache + in-flight dedup + bounded
// retry on transient errors (429 / 5xx / network). Keeps the public API
// unchanged so callers (PlaceSearchInput, etc.) require no edits.
// ---------------------------------------------------------------------------

const FORWARD_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const FORWARD_CACHE_MAX = 64;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 350;

export class GeocoderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'GeocoderError';
    this.status = status;
    this.retryable = retryable;
  }
}

interface CacheEntry {
  expiresAt: number;
  value: GeocodeSuggestion[];
}

const forwardCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GeocodeSuggestion[]>>();

function buildForwardCacheKey(query: string, opts: GeocodeOptions): string {
  const proximity = opts.proximity
    ? `${opts.proximity.lon.toFixed(3)},${opts.proximity.lat.toFixed(3)}`
    : '-';
  return [
    query.toLowerCase(),
    opts.countries ?? 'fr',
    opts.language ?? 'fr',
    opts.limit ?? 5,
    proximity,
  ].join('|');
}

function readForwardCache(key: string): GeocodeSuggestion[] | null {
  const entry = forwardCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    forwardCache.delete(key);
    return null;
  }
  // LRU touch
  forwardCache.delete(key);
  forwardCache.set(key, entry);
  return entry.value;
}

function writeForwardCache(key: string, value: GeocodeSuggestion[]): void {
  if (forwardCache.size >= FORWARD_CACHE_MAX) {
    const oldest = forwardCache.keys().next().value;
    if (oldest !== undefined) forwardCache.delete(oldest);
  }
  forwardCache.set(key, { expiresAt: Date.now() + FORWARD_CACHE_TTL_MS, value });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === RETRY_MAX_ATTEMPTS) {
        throw new GeocoderError(`Mapbox geocoder: HTTP ${res.status}`, res.status, retryable);
      }
      lastError = new GeocoderError(`Mapbox geocoder: HTTP ${res.status}`, res.status, true);
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (err instanceof GeocoderError && !err.retryable) throw err;
      if (attempt === RETRY_MAX_ATTEMPTS) {
        if (err instanceof GeocoderError) throw err;
        throw new GeocoderError(
          err instanceof Error ? err.message : 'Network error',
          0,
          true,
        );
      }
      lastError = err;
    }
    // Exponential backoff with light jitter; bail out cleanly on abort.
    const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
    await sleep(delay, signal);
  }
  // Unreachable, but keeps TypeScript happy.
  throw lastError instanceof Error ? lastError : new GeocoderError('Unknown geocoder error', 0, true);
}

export function formatGpsCoordinateLabel(lon: number, lat: number): string {
  return `${lon.toFixed(5)}, ${lat.toFixed(5)}`;
}

/**
 * Forward-geocode a free-text query. Returns an empty array for empty
 * inputs or when the Mapbox token is missing.
 */
export async function geocodePlaces(
  query: string,
  opts: GeocodeOptions = {},
): Promise<GeocodeSuggestion[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (!MAPBOX_TOKEN) {
    if (typeof console !== 'undefined') {
      console.warn('[geocoder] MAPBOX_TOKEN is missing — place search disabled');
    }
    return [];
  }

  const cacheKey = buildForwardCacheKey(trimmed, opts);
  const cached = readForwardCache(cacheKey);
  if (cached) return cached;

  // Coalesce concurrent identical requests so rapid typing or
  // simultaneous mounts cannot hammer the Mapbox endpoint.
  const existing = inFlight.get(cacheKey);
  if (existing) {
    // Honor caller cancellation without aborting the shared request.
    if (opts.signal) {
      return new Promise<GeocodeSuggestion[]>((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (opts.signal!.aborted) {
          onAbort();
          return;
        }
        opts.signal!.addEventListener('abort', onAbort, { once: true });
        existing.then(
          (value) => {
            opts.signal!.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (err) => {
            opts.signal!.removeEventListener('abort', onAbort);
            reject(err);
          },
        );
      });
    }
    return existing;
  }

  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    autocomplete: 'true',
    limit: String(Math.min(Math.max(opts.limit ?? 5, 1), 10)),
    language: opts.language ?? 'fr',
  });
  if (opts.countries) params.set('country', opts.countries);
  if (opts.proximity) {
    params.set(
      'proximity',
      `${opts.proximity.lon.toFixed(5)},${opts.proximity.lat.toFixed(5)}`,
    );
  }

  const url = `${ENDPOINT}/${encodeURIComponent(trimmed)}.json?${params.toString()}`;
  const promise = (async () => {
    const res = await fetchWithRetry(url, opts.signal);
    const json = (await res.json()) as MapboxResponse;
    const suggestions = (json.features ?? []).map((f) => ({
      id: f.id,
      name: f.text,
      fullName: f.place_name,
      lon: f.center[0],
      lat: f.center[1],
    }));
    writeForwardCache(cacheKey, suggestions);
    return suggestions;
  })();

  inFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    // Defer eviction so any other consumer awaiting the same key still sees it.
    queueMicrotask(() => {
      if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
    });
  }
}

export async function reverseGeocodeSettlement(
  lon: number,
  lat: number,
  opts: ReverseGeocodeOptions = {},
): Promise<GeocodeSuggestion | null> {
  if (!MAPBOX_TOKEN) return null;

  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    language: opts.language ?? 'fr',
    limit: String(Math.min(Math.max(opts.limit ?? 5, 1), 10)),
    types: 'place,locality,neighborhood,address',
  });
  if (opts.countries) params.set('country', opts.countries);

  const url = `${ENDPOINT}/${lon.toFixed(6)},${lat.toFixed(6)}.json?${params.toString()}`;
  const res = await fetchWithRetry(url, opts.signal);

  const maxDistanceMeters = Math.max(0, opts.maxDistanceMeters ?? 1000);
  const json = (await res.json()) as MapboxResponse;
  const features = json.features ?? [];

  // First pass: find the closest precise feature (address / neighborhood)
  // within the distance cap, and use its enclosing settlement context for
  // the label. These features have a real point geometry, so the cap is
  // meaningful.
  for (const feature of features) {
    const placeType = feature.place_type ?? [];
    const isPrecise =
      placeType.includes('address') || placeType.includes('neighborhood');
    if (!isPrecise) continue;

    const distanceMeters = haversineDistanceMeters(
      lat,
      lon,
      feature.center[1],
      feature.center[0],
    );
    if (distanceMeters > maxDistanceMeters) continue;

    const settlementContext =
      feature.context?.find(
        (entry) => entry.id.startsWith('place.') || entry.id.startsWith('locality.'),
      ) ?? null;

    return {
      id: feature.id,
      name: settlementContext?.text ?? feature.text,
      fullName: feature.place_name,
      lon: feature.center[0],
      lat: feature.center[1],
    };
  }

  // Second pass: fall back to any enclosing settlement feature. Its center
  // is a city centroid which can be several kilometers from the query
  // point, so we do NOT apply the distance cap here — Mapbox only returns
  // the `place` / `locality` whose polygon contains the query coordinates.
  for (const feature of features) {
    const placeType = feature.place_type ?? [];
    if (!placeType.includes('place') && !placeType.includes('locality')) continue;

    return {
      id: feature.id,
      name: feature.text,
      fullName: feature.place_name,
      lon: feature.center[0],
      lat: feature.center[1],
    };
  }

  return null;
}

function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}
