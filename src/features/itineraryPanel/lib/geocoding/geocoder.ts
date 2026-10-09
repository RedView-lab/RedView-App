/**
 * Enveloppe légère autour du point d'accès « places » de Mapbox Geocoding v5.
 *
 * On n'a besoin que de la recherche directe (texte → liste de suggestions) pour
 * les champs de recherche Départ / Fin de l'itinéraire. Pas de recherche
 * inverse, pas de jetons de session — rester petit. Les lieux emblématiques
 * d'OpenStreetMap (Nominatim) ne s'ajoutent que sur demande explicite
 * (`includeLandmarks`).
 */

import { MAPBOX_TOKEN } from '@/features/map3d/lib/mapbox.config';

export interface GeocodeSuggestion {
  /** Id de l'élément Mapbox (utilisé comme clé React). */
  id: string;
  /** Libellé principal, par ex. « Annecy ». */
  name: string;
  /** place_name complet, par ex. « Annecy, Haute-Savoie, France ». */
  fullName: string;
  /** Longitude WGS84. */
  lon: number;
  /** Latitude WGS84. */
  lat: number;
  /** Fournisseur du résultat : Mapbox, ou OpenStreetMap (lieux emblématiques, attribution ODbL). */
  source?: 'mapbox' | 'osm';
}

export interface GeocodeOptions {
  /** Oriente les résultats autour de ce lon/lat (centre actuel de la carte). */
  proximity?: { lon: number; lat: number };
  /** Nombre maximal de résultats (plafond Mapbox = 10). */
  limit?: number;
  /** Langue ISO-639. fr par défaut. */
  language?: string;
  /** Filtre de pays ISO-3166, séparés par des virgules, par ex. « fr,be,ch ». */
  countries?: string;
  signal?: AbortSignal;
  /**
   * Ajoute les lieux emblématiques d'OpenStreetMap (sommets, cols, sites) via
   * /api/geocode-iconic, qui relaie l'instance publique de Nominatim. Sa
   * politique d'usage interdit l'autocomplétion : seulement sur une demande
   * explicite de l'utilisateur (canSearchLandmarks), jamais à la frappe.
   */
  includeLandmarks?: boolean;
}

export interface ReverseGeocodeOptions {
  /** Nombre maximal d'éléments candidats à examiner. */
  limit?: number;
  /** Langue ISO-639. fr par défaut. */
  language?: string;
  /** Filtre de pays ISO-3166, séparés par des virgules, par ex. « fr,be,ch ». */
  countries?: string;
  /** Distance maximale au point de requête pour accepter un libellé de localité. */
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

interface NominatimSearchResult {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  name?: string;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  extratags?: Record<string, string | undefined>;
}

interface RankedGeocodeSuggestion extends GeocodeSuggestion {
  featureType: string;
  source: 'mapbox' | 'osm';
  score: number;
  iconicBoost?: number;
}

const ENDPOINT = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
const ICONIC_FALLBACK_ENDPOINT = '/api/geocode-iconic';

// ---------------------------------------------------------------------------
// Durcissement pour la production : petit cache LRU en mémoire + déduplication
// des requêtes en cours + nouvel essai borné sur les erreurs passagères
// (429 / 5xx / réseau). L'API publique reste inchangée : les appelants
// (PlaceSearchInput, etc.) n'ont rien à modifier.
// ---------------------------------------------------------------------------

const FORWARD_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const FORWARD_CACHE_MAX = 64;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 350;

class GeocoderError extends Error {
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
    opts.includeLandmarks ? 'osm' : 'mapbox',
  ].join('|');
}

function readForwardCache(key: string): GeocodeSuggestion[] | null {
  const entry = forwardCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    forwardCache.delete(key);
    return null;
  }
  // Rafraîchissement LRU
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

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function resolveCountryCodes(countries?: string): string | null {
  if (!countries) return null;
  const codes = countries
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => /^[a-z]{2}$/.test(part));
  return codes.length > 0 ? codes.join(',') : null;
}

/** Vrai si une recherche des lieux emblématiques (OpenStreetMap) a un sens pour cette saisie. */
export function canSearchLandmarks(query: string): boolean {
  const normalized = normalizeSearchText(query);
  return normalized.length >= 4 && !/\d/.test(normalized);
}

function scoreSuggestion(
  suggestion: Pick<RankedGeocodeSuggestion, 'name' | 'fullName' | 'featureType' | 'source' | 'iconicBoost'>,
  normalizedQuery: string,
  tokens: string[],
): number {
  const normalizedName = normalizeSearchText(suggestion.name);
  const normalizedFullName = normalizeSearchText(suggestion.fullName);
  let score = 0;

  if (normalizedName === normalizedQuery) score += 160;
  else if (normalizedName.startsWith(normalizedQuery)) score += 120;
  else if (normalizedFullName.startsWith(normalizedQuery)) score += 90;
  else if (normalizedFullName.includes(normalizedQuery)) score += 60;

  if (tokens.length > 0 && tokens.every((token) => normalizedName.includes(token))) {
    score += 36;
  } else if (tokens.length > 0 && tokens.every((token) => normalizedFullName.includes(token))) {
    score += 18;
  }

  switch (suggestion.featureType) {
    case 'peak':
    case 'viewpoint':
    case 'mountain':
    case 'volcano':
      score += 72;
      break;
    case 'poi':
    case 'attraction':
    case 'alpine_hut':
      score += 48;
      break;
    case 'place':
    case 'locality':
      score += 22;
      break;
    case 'neighborhood':
      score += 6;
      break;
    case 'address':
      score -= 12;
      break;
    default:
      break;
  }

  if (suggestion.source === 'osm') score += 12;
  score += suggestion.iconicBoost ?? 0;

  return score;
}

function dedupeKeyForSuggestion(suggestion: Pick<GeocodeSuggestion, 'name' | 'lon' | 'lat'>): string {
  return `${normalizeSearchText(suggestion.name)}|${suggestion.lat.toFixed(4)}|${suggestion.lon.toFixed(4)}`;
}

function rankAndMergeSuggestions(
  query: string,
  mapbox: RankedGeocodeSuggestion[],
  iconic: RankedGeocodeSuggestion[],
  limit: number,
): GeocodeSuggestion[] {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const merged = new Map<string, RankedGeocodeSuggestion>();

  for (const suggestion of [...iconic, ...mapbox]) {
    const ranked: RankedGeocodeSuggestion = {
      ...suggestion,
      score: scoreSuggestion(suggestion, normalizedQuery, tokens),
    };
    const key = dedupeKeyForSuggestion(ranked);
    const previous = merged.get(key);
    if (!previous || ranked.score > previous.score) {
      merged.set(key, ranked);
    }
  }

  return [...merged.values()]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.fullName.localeCompare(right.fullName, 'fr');
    })
    .slice(0, limit)
    .map(({ id, name, fullName, lon, lat, source }) => ({ id, name, fullName, lon, lat, source }));
}

async function fetchIconicFallbackPlaces(
  query: string,
  opts: GeocodeOptions,
): Promise<RankedGeocodeSuggestion[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(Math.min(Math.max(opts.limit ?? 6, 1), 6)),
  });
  params.set('accept-language', opts.language ?? 'fr');
  const countryCodes = resolveCountryCodes(opts.countries);
  if (countryCodes) params.set('countrycodes', countryCodes);

  const response = await fetch(`${ICONIC_FALLBACK_ENDPOINT}?${params.toString()}`, {
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new GeocoderError(`Iconic geocoder: HTTP ${response.status}`, response.status, true);
  }

  const normalizedQuery = normalizeSearchText(query);
  const rows = ((await response.json()) as NominatimSearchResult[]).filter((row) => {
    const normalizedName = normalizeSearchText(row.name ?? row.display_name);
    const normalizedFullName = normalizeSearchText(row.display_name);
    return (
      normalizedName === normalizedQuery ||
      normalizedName.startsWith(normalizedQuery) ||
      normalizedFullName.includes(normalizedQuery)
    );
  });

  const suggestions: RankedGeocodeSuggestion[] = [];
  for (const row of rows) {
    const lon = Number(row.lon);
    const lat = Number(row.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    const extratags = row.extratags ?? {};
    const elevationMeters = Number(extratags.ele ?? NaN);
    let iconicBoost = 0;
    if (extratags.wikipedia) iconicBoost += 120;
    if (extratags.wikidata) iconicBoost += 40;
    if (extratags.importance === 'international') iconicBoost += 80;
    if (Number.isFinite(elevationMeters)) {
      if (elevationMeters >= 4000) iconicBoost += 70;
      else if (elevationMeters >= 2500) iconicBoost += 40;
      else if (elevationMeters >= 1500) iconicBoost += 20;
    }

    const name = row.name?.trim() || row.display_name.split(',')[0]?.trim() || query.trim();
    suggestions.push({
      id: `osm:${row.osm_type ?? 'place'}:${row.osm_id ?? row.place_id}`,
      name,
      fullName: row.display_name,
      lon,
      lat,
      featureType: row.type ?? 'unknown',
      source: 'osm',
      score: 0,
      iconicBoost,
    });
  }

  return suggestions;
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
    // Recul exponentiel avec un léger aléa ; sortie propre en cas d'annulation.
    const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
    await sleep(delay, signal);
  }
  // Inatteignable, mais satisfait TypeScript.
  throw lastError instanceof Error ? lastError : new GeocoderError('Unknown geocoder error', 0, true);
}

export { formatGpsCoordinateLabel } from './coordinateLabel';

/**
 * Géocode en direct une requête en texte libre. Renvoie un tableau vide pour
 * une saisie vide ou quand le jeton Mapbox manque.
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

  // Regrouper les requêtes identiques simultanées pour qu'une frappe rapide ou
  // des montages simultanés ne puissent pas marteler le point d'accès Mapbox.
  const existing = inFlight.get(cacheKey);
  if (existing) {
    // Respecter l'annulation de l'appelant sans interrompre la requête partagée.
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

  const finalLimit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
  const mapboxLimit = Math.min(Math.max(finalLimit + 4, finalLimit), 10);

  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    autocomplete: 'true',
    limit: String(mapboxLimit),
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
    const iconicPromise = opts.includeLandmarks && canSearchLandmarks(trimmed)
      ? fetchIconicFallbackPlaces(trimmed, {
          ...opts,
          limit: 6,
        }).catch((error: unknown) => {
          if (isAbortError(error)) throw error;
          if (typeof console !== 'undefined') {
            console.warn('[geocoder] iconic fallback failed', error);
          }
          return [] as RankedGeocodeSuggestion[];
        })
      : Promise.resolve([] as RankedGeocodeSuggestion[]);

    const res = await fetchWithRetry(url, opts.signal);
    const json = (await res.json()) as MapboxResponse;
    const mapboxSuggestions: RankedGeocodeSuggestion[] = (json.features ?? []).map((f) => ({
      id: f.id,
      name: f.text,
      fullName: f.place_name,
      lon: f.center[0],
      lat: f.center[1],
      featureType: f.place_type?.[0] ?? 'unknown',
      source: 'mapbox',
      score: 0,
    }));
    const iconicSuggestions = await iconicPromise;
    const suggestions = rankAndMergeSuggestions(
      trimmed,
      mapboxSuggestions,
      iconicSuggestions,
      finalLimit,
    );
    writeForwardCache(cacheKey, suggestions);
    return suggestions;
  })();

  inFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    // Différer l'éviction pour qu'un autre consommateur qui attend la même clé la voie encore.
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
  if (!MAPBOX_TOKEN || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    language: opts.language ?? 'fr',
    types: 'place,locality,neighborhood,address',
  });
  if (opts.countries) params.set('country', opts.countries);

  const url = `${ENDPOINT}/${lon.toFixed(6)},${lat.toFixed(6)}.json?${params.toString()}`;
  const res = await fetchWithRetry(url, opts.signal);

  const maxDistanceMeters = Math.max(0, opts.maxDistanceMeters ?? 1000);
  const json = (await res.json()) as MapboxResponse;
  const features = json.features ?? [];

  // Première passe : trouver l'élément précis le plus proche (adresse / quartier)
  // dans la limite de distance, et utiliser le contexte de localité qui l'englobe
  // pour le libellé. Ces éléments ont une vraie géométrie ponctuelle, la limite
  // a donc un sens.
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

  // Seconde passe : se rabattre sur n'importe quel élément de localité
  // englobant. Son centre est le centroïde d'une ville, qui peut être à
  // plusieurs kilomètres du point de requête : on n'applique donc PAS la limite
  // de distance ici — Mapbox ne renvoie que le `place` / `locality` dont le
  // polygone contient les coordonnées de la requête.
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
