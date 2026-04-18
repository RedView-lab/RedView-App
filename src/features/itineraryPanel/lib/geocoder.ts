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

interface MapboxFeature {
  id: string;
  text: string;
  place_name: string;
  center: [number, number]; // [lon, lat]
}

interface MapboxResponse {
  features: MapboxFeature[];
}

const ENDPOINT = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

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
