/**
 * Client du serveur POI self-hébergé (`redview-poi-server`).
 *
 * Architecture :
 *   browser → /api/poi  (Vercel Function, masque l'IP du VPS)
 *           → http://<vps>/poi/{bbox|corridor}
 *           → Fastify → SQLite + R*Tree
 *
 * Le service backend prend en charge :
 *   - bbox queries
 *   - corridor queries (polyligne + radius) en une seule requête, pas de
 *     chunking côté client (la DB R*Tree est ~50 ms, peu importe la
 *     taille de la GPX, contre 20+ requêtes Overpass séquentielles).
 *
 * Pour rester compatible avec le hook existant `usePoi`, on expose une
 * fonction `fetchPoisAlongRouteChunked` qui simule le streaming
 * (`onProgress` est appelé à 50 % puis à 100 %) — la latence réelle
 * justifie rarement plus.
 */
import type { PoiCategory, PoiFeature, PoiApiResponse } from '../types';

const ENDPOINT = '/api/poi';
const REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const onCallerAbort = () => ctrl.abort();
  if (callerSignal) {
    if (callerSignal.aborted) throw new DOMException('Aborted', 'AbortError');
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

// ── BBOX ──────────────────────────────────────────────────────────────

export async function fetchPoisInBbox(
  south: number,
  west: number,
  north: number,
  east: number,
  categories: PoiCategory[],
  signal?: AbortSignal,
  limit?: number,
): Promise<PoiFeature[]> {
  if (categories.length === 0) return [];

  const params = new URLSearchParams({
    south: String(south),
    west: String(west),
    north: String(north),
    east: String(east),
    categories: categories.join(','),
    op: 'bbox',
  });
  if (Number.isFinite(limit) && (limit ?? 0) > 0) {
    params.set('limit', String(Math.round(limit as number)));
  }

  const res = await fetchWithTimeout(
    `${ENDPOINT}?${params.toString()}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    signal,
    REQUEST_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`POI bbox HTTP ${res.status}`);
  const data: PoiApiResponse = await res.json();
  return data.features;
}

// ── CORRIDOR ──────────────────────────────────────────────────────────

export async function fetchPoisAlongRoute(
  points: { lat: number; lon: number }[],
  radiusM: number,
  categories: PoiCategory[],
  signal?: AbortSignal,
): Promise<PoiFeature[]> {
  if (points.length === 0 || categories.length === 0) return [];

  const body = JSON.stringify({
    points: points.map((p) => [p.lat, p.lon]),
    radiusM,
    categories,
  });

  const res = await fetchWithTimeout(
    `${ENDPOINT}?op=corridor`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    },
    signal,
    REQUEST_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`POI corridor HTTP ${res.status}`);
  const data: PoiApiResponse = await res.json();
  return data.features;
}

// ── Compat shim pour usePoi (anciennement chunked Overpass) ──────────

interface CorridorChunkedOptions {
  samples: { lat: number; lon: number }[];
  radiusM: number;
  categories: PoiCategory[];
  signal?: AbortSignal;
  onProgress?: (
    deduped: PoiFeature[],
    progress: { done: number; total: number },
  ) => void;
}

/**
 * Drop-in remplaçant de l'ancien `fetchPoisAlongRouteChunked` Overpass.
 *
 * Le backend SQLite renvoie tout en une seule requête, donc le
 * "streaming" ici est dégénéré : on appelle `onProgress` une fois à
 * 50 % avant la requête (état vide) puis à 100 % avec le résultat
 * final. Ça suffit pour conserver l'UI feedback de la barre de
 * progression sans changer le contrat du hook.
 */
export async function fetchPoisAlongRouteChunked(
  options: CorridorChunkedOptions,
): Promise<PoiFeature[]> {
  const { samples, radiusM, categories, signal, onProgress } = options;
  if (samples.length === 0 || categories.length === 0) return [];

  onProgress?.([], { done: 0, total: 1 });

  const features = await fetchPoisAlongRoute(samples, radiusM, categories, signal);

  onProgress?.(features, { done: 1, total: 1 });
  return features;
}
