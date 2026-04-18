import type { PoiCategory, PoiFeature, OverpassResponse } from '../types';

// ── Overpass endpoints (fallback chain) ───────────────────────────────
// Ordered by observed reliability. `overpass-api.de` is the canonical
// instance and is generally up; `kumi.systems` is fast when healthy but
// has been intermittently unreachable (DNS/timeout) — keep it as a
// fallback so a regional outage doesn't break the corridor search.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** Per-request hard timeout. Without this, a TCP-level hang on an
 * unreachable mirror would block the whole corridor search at 0% for
 * ~2 minutes (browser default) before the fallback gets a chance. */
const ENDPOINT_TIMEOUT_MS = 35_000;

/**
 * Fetch with a hard timeout that races against any caller-supplied
 * AbortSignal. Aborting either signal cancels the underlying request
 * and rejects with the appropriate AbortError.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const onCallerAbort = () => ctrl.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

// ── OSM tag → PoiCategory mapping ─────────────────────────────────────

interface TagMapping {
  key: string;
  value: string;
  category: PoiCategory;
}

const TAG_MAPPINGS: TagMapping[] = [
  { key: 'amenity', value: 'drinking_water', category: 'drinking_water' },
  { key: 'shop', value: 'bakery', category: 'bakery' },
  { key: 'shop', value: 'convenience', category: 'convenience' },
  { key: 'shop', value: 'supermarket', category: 'supermarket' },
  { key: 'shop', value: 'bicycle', category: 'bicycle' },
  { key: 'amenity', value: 'bicycle_repair_station', category: 'bicycle_repair' },
  { key: 'amenity', value: 'toilets', category: 'toilets' },
  { key: 'amenity', value: 'shelter', category: 'shelter' },
  { key: 'tourism', value: 'camp_site', category: 'camp_site' },
  { key: 'amenity', value: 'pharmacy', category: 'pharmacy' },
  { key: 'amenity', value: 'hospital', category: 'hospital' },
];

// ── Build Overpass QL query ───────────────────────────────────────────

function buildQuery(
  south: number,
  west: number,
  north: number,
  east: number,
  categories: PoiCategory[],
): string {
  const enabledMappings = TAG_MAPPINGS.filter((m) => categories.includes(m.category));
  if (enabledMappings.length === 0) return '';

  const bbox = `(${south},${west},${north},${east})`;
  const nodeQueries = enabledMappings
    .map((m) => `  node[${m.key}=${m.value}]${bbox};`)
    .join('\n');

  // Fetch ways/areas too — many POIs (shops, pharmacies, shelters…) are mapped as areas in OSM
  const wayQueries = enabledMappings
    .map((m) => `  way[${m.key}=${m.value}]${bbox};`)
    .join('\n');

  return `[out:json][timeout:30];
(
${nodeQueries}
${wayQueries}
);
out center body qt;`;
}

// ── Parse response into PoiFeature[] ──────────────────────────────────

function classifyElement(tags: Record<string, string>): PoiCategory | null {
  for (const m of TAG_MAPPINGS) {
    if (tags[m.key] === m.value) return m.category;
  }
  return null;
}

function parseResponse(data: OverpassResponse): PoiFeature[] {
  const results: PoiFeature[] = [];

  for (const el of data.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    const tags = el.tags ?? {};
    const category = classifyElement(tags);
    if (!category) continue;

    results.push({
      id: el.id,
      lat,
      lon,
      category,
      name: tags.name ?? null,
      tags,
    });
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────

export async function fetchPoisInBbox(
  south: number,
  west: number,
  north: number,
  east: number,
  categories: PoiCategory[],
  signal?: AbortSignal,
): Promise<PoiFeature[]> {
  const query = buildQuery(south, west, north, east, categories);
  if (!query) return [];

  let lastError: Error | null = null;

  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        },
        signal,
        ENDPOINT_TIMEOUT_MS,
      );

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Overpass ${res.status}`);
        continue; // try fallback
      }

      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);

      const json: OverpassResponse = await res.json();
      return parseResponse(json);
    } catch (err: unknown) {
      // Caller-initiated abort propagates; timeout-aborts (caller signal
      // not aborted) fall through to the next mirror.
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (signal?.aborted) throw err;
        lastError = new Error(`Overpass timeout (${endpoint})`);
        continue;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      continue; // try fallback (network error, JSON parse, etc.)
    }
  }

  throw lastError ?? new Error('All Overpass endpoints failed');
}

// ── Corridor query (around a polyline) ────────────────────────────────

function buildCorridorQuery(
  points: { lat: number; lon: number }[],
  radiusM: number,
  categories: PoiCategory[],
): string {
  const enabled = TAG_MAPPINGS.filter((m) => categories.includes(m.category));
  if (enabled.length === 0 || points.length === 0) return '';

  const coords = points.map((p) => `${p.lat},${p.lon}`).join(',');
  const around = `(around:${radiusM},${coords})`;

  const nodeQueries = enabled
    .map((m) => `  node[${m.key}=${m.value}]${around};`)
    .join('\n');

  const wayQueries = enabled
    .map((m) => `  way[${m.key}=${m.value}]${around};`)
    .join('\n');

  return `[out:json][timeout:45];
(
${nodeQueries}
${wayQueries}
);
out center body qt;`;
}

export async function fetchPoisAlongRoute(
  points: { lat: number; lon: number }[],
  radiusM: number,
  categories: PoiCategory[],
  signal?: AbortSignal,
): Promise<PoiFeature[]> {
  const query = buildCorridorQuery(points, radiusM, categories);
  if (!query) return [];

  let lastError: Error | null = null;

  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        },
        signal,
        ENDPOINT_TIMEOUT_MS,
      );

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Overpass ${res.status}`);
        continue;
      }

      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);

      const json: OverpassResponse = await res.json();
      return parseResponse(json);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (signal?.aborted) throw err;
        lastError = new Error(`Overpass timeout (${endpoint})`);
        continue;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  throw lastError ?? new Error('All Overpass endpoints failed');
}

// ── Chunked corridor fetch (long GPX) ─────────────────────────────────

/** Maximum sample points per Overpass `around:` call. Each disk costs
 * server time; ~80 points per chunk keeps a single request well under
 * the 45 s timeout even with all 11 categories enabled. */
const CORRIDOR_CHUNK_SIZE = 80;

interface CorridorChunkedOptions {
  /** Sample points already spaced so disks of radius `radiusM` overlap. */
  samples: { lat: number; lon: number }[];
  radiusM: number;
  categories: PoiCategory[];
  signal?: AbortSignal;
  /** Fired after each chunk merges into the running result set. */
  onProgress?: (
    deduped: PoiFeature[],
    progress: { done: number; total: number },
  ) => void;
}

/**
 * Run the corridor query in sequential chunks of {@link CORRIDOR_CHUNK_SIZE}
 * sample points, deduplicating features by id and streaming partial
 * results to {@link CorridorChunkedOptions.onProgress}.
 *
 * Sequential (not parallel) on purpose: Overpass enforces a per-IP slot
 * limit and rejects bursts with HTTP 429. Sequential calls keep us inside
 * the slot budget while still giving the user incremental visual feedback.
 */
export async function fetchPoisAlongRouteChunked(
  options: CorridorChunkedOptions,
): Promise<PoiFeature[]> {
  const { samples, radiusM, categories, signal, onProgress } = options;
  if (samples.length === 0 || categories.length === 0) return [];

  const chunks: { lat: number; lon: number }[][] = [];
  for (let i = 0; i < samples.length; i += CORRIDOR_CHUNK_SIZE) {
    chunks.push(samples.slice(i, i + CORRIDOR_CHUNK_SIZE));
  }

  const seen = new Map<number, PoiFeature>();
  const total = chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const features = await fetchPoisAlongRoute(
      chunks[i],
      radiusM,
      categories,
      signal,
    );
    for (const f of features) {
      if (!seen.has(f.id)) seen.set(f.id, f);
    }
    onProgress?.(Array.from(seen.values()), { done: i + 1, total });
  }

  return Array.from(seen.values());
}