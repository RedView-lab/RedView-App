import type { WindPoint, WindDataSource, WindGridDefinition, WindTimeSelection } from '../types';
import { coordCacheKey } from './wind-grid';
import { OPENMETEO_FORECAST_URL, OPENMETEO_MODEL } from './openMeteoConfig';
import { translateAppText } from '@/shared/i18n';
import { logger } from '@/shared/lib/logger';
import { createSharedRequests } from '@/shared/lib/sharedRequests';
import {
  normaliseWindRequestedHourKey,
  normaliseWindSelection,
  windSelectionKey,
  WIND_TIMEZONE,
} from './windSelection';

// ── Configuration ─────────────────────────────────────────────────────

const CACHE_TTL_MS = 45 * 60 * 1000; // 45 minutes
// VPS auto-hébergé → on peut le solliciter fort. Lots plus gros, pas de pause
// entre les lots, seulement un tout petit budget de nouvel essai de sécurité
// pour les erreurs transitoires.
const BATCH_SIZE = 200; // Garde les URL sous les limites du proxy / navigateur pour les requêtes multipoints
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1_000;
const MIN_REQUEST_GAP_MS = 0;
const INTER_BATCH_DELAY_MS = 0;

// ── Refroidissement global après limitation de débit ──────────────────

let rateLimitedUntil = 0;
let lastRequestTime = 0;

// ── Cache en mémoire ──────────────────────────────────────────────────

interface WindHourlyCacheEntry {
  hours: Map<string, WindPoint>;
  fetchedAt: number;
}

const cache = new Map<string, WindHourlyCacheEntry>();

type WindGridResult = { points: WindPoint[]; source: WindDataSource | null };

/**
 * Chargements de grille partagés par sélection (sharedRequests.ts), entre
 * l'affichage et le préchargement de l'heure suivante, progression relayée à
 * chacun. Liés au signal du premier : passer à l'heure en cours de
 * préchargement annule ce préchargement, le chargement de cette heure le
 * reprenait, prenait son rejet pour sa propre annulation et le vent restait
 * « en chargement » jusqu'au déplacement suivant de la carte. Un chargement
 * abandonné par tous repart de zéro, les lots déjà reçus restant en cache.
 */
const windGridRequests = createSharedRequests<WindGridResult, WindFetchProgress>();

function toDailyCacheKey(lat: number, lng: number, dateIso: string): string {
  return `${coordCacheKey(lat, lng)}|${dateIso}`;
}

function normaliseApiHourKey(timeValue: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})/.exec(timeValue);
  return match ? `${match[1]}:00` : null;
}

function getCached(lat: number, lng: number, selection: WindTimeSelection): WindPoint | null {
  const key = toDailyCacheKey(lat, lng, selection.date);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.hours.get(normaliseWindRequestedHourKey(selection.date, selection.time)) ?? null;
}

function setCache(lat: number, lng: number, dateIso: string, hours: Map<string, WindPoint>): void {
  const key = toDailyCacheKey(lat, lng, dateIso);
  const existing = cache.get(key);
  const mergedHours = existing && Date.now() - existing.fetchedAt <= CACHE_TTL_MS
    ? new Map(existing.hours)
    : new Map<string, WindPoint>();

  hours.forEach((point, hourKey) => {
    mergedHours.set(hourKey, point);
  });

  cache.set(key, { hours: mergedHours, fetchedAt: Date.now() });
}

function gridSelectionCacheKey(grid: WindGridDefinition, selection: WindTimeSelection): string {
  const { north, south, east, west, spacing } = grid.bounds;
  const normalisedSelection = normaliseWindSelection(selection);
  return [
    normalisedSelection.date,
    normalisedSelection.time,
    grid.rows,
    grid.cols,
    north.toFixed(6),
    south.toFixed(6),
    east.toFixed(6),
    west.toFixed(6),
    spacing.toFixed(6),
  ].join('|');
}

// ── Appel à l'API ─────────────────────────────────────────────────────

interface OpenMeteoResponse {
  latitude: number | number[];
  longitude: number | number[];
  hourly: {
    time: string[];
    wind_speed_10m: Array<number | null>;
    wind_direction_10m: Array<number | null>;
    wind_gusts_10m: Array<number | null>;
  };
}

interface FetchBatchResult {
  points: WindPoint[];
  source: WindDataSource;
}

export interface WindFetchProgress {
  completedBatches: number;
  totalBatches: number;
  source: WindDataSource | null;
  detail: string;
}

function normaliseBatchPoint(
  item: OpenMeteoResponse | undefined,
  fallbackCoord: { lat: number; lng: number },
  selection: WindTimeSelection,
): WindPoint {
  if (!item?.hourly?.time?.length) {
    throw new Error(`Wind batch returned no hourly data for ${fallbackCoord.lat.toFixed(4)},${fallbackCoord.lng.toFixed(4)}`);
  }

  const lat = Array.isArray(item.latitude) ? item.latitude[0] : item.latitude;
  const lng = Array.isArray(item.longitude) ? item.longitude[0] : item.longitude;
  const resolvedLat = Number.isFinite(lat) ? lat : fallbackCoord.lat;
  const resolvedLng = Number.isFinite(lng) ? lng : fallbackCoord.lng;
  const hours = new Map<string, WindPoint>();

  item.hourly.time.forEach((timeValue, hourlyIndex) => {
    const hourKey = normaliseApiHourKey(timeValue);
    if (!hourKey) return;
    hours.set(hourKey, {
      lat: resolvedLat,
      lng: resolvedLng,
      speed: item.hourly.wind_speed_10m[hourlyIndex] ?? 0,
      direction: item.hourly.wind_direction_10m[hourlyIndex] ?? 0,
      gusts: item.hourly.wind_gusts_10m[hourlyIndex] ?? 0,
    });
  });

  if (hours.size === 0) {
    throw new Error(`Wind batch returned no usable hours for ${fallbackCoord.lat.toFixed(4)},${fallbackCoord.lng.toFixed(4)}`);
  }

  setCache(resolvedLat, resolvedLng, selection.date, hours);
  const selectedPoint = getCached(resolvedLat, resolvedLng, selection);
  if (!selectedPoint) {
    throw new Error(`Wind batch missing selected hour for ${fallbackCoord.lat.toFixed(4)},${fallbackCoord.lng.toFixed(4)}`);
  }

  return selectedPoint;
}

function resolveWindSource(response: Response): WindDataSource {
  return response.headers.get('X-Weather-Source') === 'self-hosted-vps' ? 'self-hosted-vps' : 'unknown';
}

function formatDateIso(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatTimeIso(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function shiftSelectionByHours(selection: WindTimeSelection, hoursOffset: number): WindTimeSelection | null {
  const normalised = normaliseWindSelection(selection);
  const [yearText, monthText, dayText] = normalised.date.split('-');
  const [hourText, minuteText] = normalised.time.split(':');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hours = Number(hourText);
  const minutes = Number(minuteText);

  if (![year, month, day, hours, minutes].every(Number.isFinite)) return null;

  const next = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (Number.isNaN(next.getTime())) return null;

  next.setHours(next.getHours() + hoursOffset);

  return {
    ...selection,
    date: formatDateIso(next),
    time: normaliseWindRequestedHourKey(formatDateIso(next), formatTimeIso(next)).slice(11),
  };
}

/**
 * Récupère un seul lot de données de vent (jusqu'à BATCH_SIZE coordonnées).
 */
async function fetchBatch(
  coords: { lat: number; lng: number }[],
  selection: WindTimeSelection,
  signal?: AbortSignal,
): Promise<FetchBatchResult> {
  const lats = coords.map((c) => c.lat.toFixed(4)).join(',');
  const lngs = coords.map((c) => c.lng.toFixed(4)).join(',');
  const forecastIso = normaliseWindRequestedHourKey(selection.date, selection.time);
  const timeParam = encodeURIComponent(forecastIso);

  const url =
    `${OPENMETEO_FORECAST_URL}?latitude=${lats}&longitude=${lngs}` +
    `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&start_hour=${timeParam}&end_hour=${timeParam}` +
    `&wind_speed_unit=ms&timeformat=iso8601&timezone=${encodeURIComponent(WIND_TIMEZONE)}&cell_selection=nearest` +
    `&models=${OPENMETEO_MODEL}`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Respecte le refroidissement global après un 429 précédent
    const cooldownWait = rateLimitedUntil - Date.now();
    // Respecte l'écart minimal entre deux requêtes
    const gapWait = (lastRequestTime + MIN_REQUEST_GAP_MS) - Date.now();
    const waitMs = Math.max(0, cooldownWait, gapWait);

    if (waitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }

    lastRequestTime = Date.now();
    const res = await fetch(url, { signal });

    if (res.status === 429) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      rateLimitedUntil = Date.now() + backoff;
      console.warn(`[wind] Open-Meteo 429, backing off ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      lastError = new Error(`Open-Meteo 429: Too Many Requests`);
      if (attempt < MAX_RETRIES) continue;
      throw lastError;
    }

    if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${res.statusText}`);

    const source = resolveWindSource(res);
    logger.weather.debug(`wind batch: ${coords.length} coords via ${source}`);

    const json = await res.json();

    // Une seule coordonnée → la réponse est un objet ; plusieurs → un tableau
    const items: OpenMeteoResponse[] = Array.isArray(json) ? json : [json];

    if (items.length !== coords.length) {
      throw new Error(`Wind batch cardinality mismatch: requested ${coords.length}, received ${items.length}`);
    }

    return {
      source,
      points: coords.map((fallbackCoord, index) => normaliseBatchPoint(items[index], fallbackCoord, selection)),
    };
  }

  throw lastError ?? new Error('Open-Meteo fetch failed');
}

/**
 * Récupère une grille de vent régulière complète depuis le VPS auto-hébergé.
 * Les résultats gardent l'ordre ligne par ligne de la grille pour un envoi
 * direct au GPU. Annulable via AbortSignal.
 */
async function fetchWindGridForSelectionInternal(
  grid: WindGridDefinition,
  selection: WindTimeSelection,
  signal?: AbortSignal,
  onProgress?: (progress: WindFetchProgress) => void,
): Promise<{ points: WindPoint[]; source: WindDataSource | null }> {
  const normalisedSelection = normaliseWindSelection(selection);
  const results = new Array<WindPoint>(grid.points.length);
  const uncachedIndexes: number[] = [];

  // 1. Regarde d'abord le cache
  for (let index = 0; index < grid.points.length; index += 1) {
    const point = grid.points[index];
    const cached = getCached(point.lat, point.lng, normalisedSelection);
    if (cached) {
      results[index] = {
        ...cached,
        lat: point.lat,
        lng: point.lng,
      };
    } else {
      uncachedIndexes.push(index);
    }
  }

  if (uncachedIndexes.length === 0) {
    return { points: results, source: null };
  }

  const totalBatches = Math.max(1, Math.ceil(uncachedIndexes.length / BATCH_SIZE));
  let lastSource: WindDataSource | null = null;
  onProgress?.({
    completedBatches: 0,
    totalBatches,
    source: null,
    detail: translateAppText('Préparation vent {{date}} {{time}} ({{cols}}×{{rows}})', {
      date: normalisedSelection.date,
      time: normalisedSelection.time,
      cols: grid.cols,
      rows: grid.rows,
    }),
  });

  // 2. Récupère par lots les coordonnées absentes du cache (avec pause entre les lots)
  for (let i = 0; i < uncachedIndexes.length; i += BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Pause entre les lots pour éviter un 429 sur des lots consécutifs
    if (i > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, INTER_BATCH_DELAY_MS);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }

    const batchIndexes = uncachedIndexes.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const batch = batchIndexes.map((pointIndex) => grid.points[pointIndex]);
    const { points, source } = await fetchBatch(batch, normalisedSelection, signal);
    lastSource = source;
    points.forEach((point, batchIndex) => {
      const pointIndex = batchIndexes[batchIndex];
      const gridPoint = grid.points[pointIndex];
      results[pointIndex] = { ...point, lat: gridPoint.lat, lng: gridPoint.lng };
    });

    onProgress?.({
      completedBatches: batchNumber,
      totalBatches,
      source: lastSource,
      detail: translateAppText(
        lastSource ? 'Vent {{date}} {{time}} {{batch}}/{{total}} via {{source}}' : 'Vent {{date}} {{time}} {{batch}}/{{total}}',
        {
          date: normalisedSelection.date,
          time: normalisedSelection.time,
          batch: batchNumber,
          total: totalBatches,
          source: lastSource ?? '',
        },
      ),
    });
  }

  if (lastSource) {
    console.info(`[wind] fetched grid ${grid.cols}x${grid.rows} (${results.length} points) via ${lastSource}`);
  }

  const missingPoints = results.reduce((count, point) => count + (point ? 0 : 1), 0);
  if (missingPoints > 0) {
    throw new Error(`Wind grid incomplete after fetch: ${missingPoints} missing points out of ${results.length}`);
  }

  return { points: results, source: lastSource };
}

async function fetchWindGridForSelection(
  grid: WindGridDefinition,
  selection: WindTimeSelection,
  signal?: AbortSignal,
  onProgress?: (progress: WindFetchProgress) => void,
): Promise<WindGridResult> {
  const key = gridSelectionCacheKey(grid, selection);
  if (windGridRequests.has(key)) {
    onProgress?.({
      completedBatches: 0,
      totalBatches: 1,
      source: null,
      detail: translateAppText('Réutilisation du chargement vent en cours {{key}} ({{cols}}×{{rows}})', {
        key: windSelectionKey(selection),
        cols: grid.cols,
        rows: grid.rows,
      }),
    });
  }
  return windGridRequests.run(
    key,
    (requestSignal, emit) => fetchWindGridForSelectionInternal(grid, selection, requestSignal, emit),
    { signal, onEvent: onProgress },
  );
}

export function hasWindGridSelectionCached(
  grid: WindGridDefinition,
  selection: WindTimeSelection,
): boolean {
  const normalisedSelection = normaliseWindSelection(selection);
  return grid.points.every((point) => getCached(point.lat, point.lng, normalisedSelection));
}

export async function fetchWindGridData(
  grid: WindGridDefinition,
  selection: WindTimeSelection,
  signal?: AbortSignal,
  onProgress?: (progress: WindFetchProgress) => void,
): Promise<WindPoint[]> {
  const { points } = await fetchWindGridForSelection(grid, selection, signal, onProgress);
  return points;
}

export async function prefetchWindGridData(
  grid: WindGridDefinition,
  selection: WindTimeSelection,
  signal?: AbortSignal,
): Promise<void> {
  const candidates = [
    shiftSelectionByHours(selection, 1),
    shiftSelectionByHours(selection, 24),
  ];
  const seen = new Set<string>();

  for (const nextSelection of candidates) {
    if (!nextSelection) continue;
    const nextSelectionKey = windSelectionKey(nextSelection);
    if (seen.has(nextSelectionKey)) continue;
    seen.add(nextSelectionKey);
    if (hasWindGridSelectionCached(grid, nextSelection)) continue;

    try {
      await fetchWindGridForSelection(grid, nextSelection, signal);
      if (signal?.aborted) return;
      console.info(`[wind] prefetched hourly cache for ${nextSelectionKey}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.warn(`[wind] background prefetch failed for ${nextSelectionKey}`, error);
      return;
    }
  }
}

/**
 * Vide le cache des données de vent.
 */
export function clearWindCache(): void {
  cache.clear();
}
