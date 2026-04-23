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
  if (!MAPBOX_TOKEN) return [];

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
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) {
    throw new Error(`Mapbox geocoder: HTTP ${res.status}`);
  }
  const json = (await res.json()) as MapboxResponse;
  return (json.features ?? []).map((f) => ({
    id: f.id,
    name: f.text,
    fullName: f.place_name,
    lon: f.center[0],
    lat: f.center[1],
  }));
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
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) {
    throw new Error(`Mapbox reverse geocoder: HTTP ${res.status}`);
  }

  const maxDistanceMeters = Math.max(0, opts.maxDistanceMeters ?? 1000);
  const json = (await res.json()) as MapboxResponse;
  for (const feature of json.features ?? []) {
    const distanceMeters = haversineDistanceMeters(
      lat,
      lon,
      feature.center[1],
      feature.center[0],
    );
    if (distanceMeters > maxDistanceMeters) continue;

    const placeType = feature.place_type ?? [];
    const settlementContext =
      feature.context?.find(
        (entry) => entry.id.startsWith('place.') || entry.id.startsWith('locality.'),
      ) ?? null;
    const name =
      placeType.includes('place') || placeType.includes('locality')
        ? feature.text
        : settlementContext?.text ?? feature.text;

    return {
      id: feature.id,
      name,
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
