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

/**
 * Échec de l'API POI (HTTP non-2xx, délai dépassé, réponse invalide).
 * `status` vaut 0 pour un délai dépassé ou une erreur réseau.
 */
export class PoiApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PoiApiError';
    this.status = status;
  }
}

async function readApiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  } catch {
    /* corps non JSON */
  }
  return fallback;
}

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
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    // Un délai dépassé n'est pas une annulation de l'appelant : on le
    // remonte comme une vraie erreur (sinon l'UI l'ignorerait en silence).
    if (timedOut && !callerSignal?.aborted) throw new PoiApiError('POI request timeout', 0);
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

// ── BBOX ──────────────────────────────────────────────────────────────

/**
 * Spatial sampling for zoomed-out views: at most one POI per category per
 * XYZ tile cell of `level`, and at most `perCell` categories per cell.
 * Without it the server returns the first `limit` rows in R*Tree order,
 * i.e. one clump in a corner of any bbox denser than `limit`.
 */
export interface PoiBboxSampling {
  level: number;
  perCell?: number;
}

export async function fetchPoisInBbox(
  south: number,
  west: number,
  north: number,
  east: number,
  categories: PoiCategory[],
  signal?: AbortSignal,
  limit?: number,
  sampling?: PoiBboxSampling,
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
  if (sampling && Number.isFinite(sampling.level)) {
    params.set('level', String(Math.round(sampling.level)));
    if (sampling.perCell && sampling.perCell > 0) {
      params.set('per_cell', String(Math.round(sampling.perCell)));
    }
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

/** Bornes acceptées par le serveur POI (au-delà : HTTP 400). */
export const POI_CORRIDOR_MIN_RADIUS_M = 1;
export const POI_CORRIDOR_MAX_RADIUS_M = 10_000;
export const POI_CORRIDOR_MAX_POINTS = 10_000;
const POI_CORRIDOR_DEFAULT_RADIUS_M = 1_000;

export function clampCorridorRadiusM(radiusM: number): number {
  if (!Number.isFinite(radiusM)) return POI_CORRIDOR_DEFAULT_RADIUS_M;
  return Math.min(POI_CORRIDOR_MAX_RADIUS_M, Math.max(POI_CORRIDOR_MIN_RADIUS_M, radiusM));
}

/** Garde-fou : sous-échantillonne uniformément (en gardant le dernier point) au-delà du plafond serveur. */
function capCorridorPoints<T>(points: T[]): T[] {
  if (points.length <= POI_CORRIDOR_MAX_POINTS) return points;
  const stride = Math.ceil(points.length / POI_CORRIDOR_MAX_POINTS);
  const out: T[] = [];
  for (let i = 0; i < points.length && out.length < POI_CORRIDOR_MAX_POINTS - 1; i += stride) {
    out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

export async function fetchPoisAlongRoute(
  points: { lat: number; lon: number }[],
  radiusM: number,
  categories: PoiCategory[],
  signal?: AbortSignal,
): Promise<PoiFeature[]> {
  if (points.length === 0 || categories.length === 0) return [];

  const body = JSON.stringify({
    // 6 décimales ≈ 0,1 m : corps ~2× plus léger qu'en double précision.
    points: capCorridorPoints(points).map((p) => [
      Math.round(p.lat * 1e6) / 1e6,
      Math.round(p.lon * 1e6) / 1e6,
    ]),
    radiusM: clampCorridorRadiusM(radiusM),
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
  if (!res.ok) {
    throw new PoiApiError(await readApiErrorMessage(res, `POI corridor HTTP ${res.status}`), res.status);
  }
  const data = (await res.json().catch(() => null)) as PoiApiResponse | null;
  if (!data || !Array.isArray(data.features)) {
    throw new PoiApiError('POI corridor: invalid response', res.status);
  }
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
