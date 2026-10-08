/**
 * Client HTTP BRouter — requêtes.
 *
 * Deux opérations :
 *  - `fetchBrouterRoute(req)` → route une requête, renvoie les métadonnées parsées.
 *  - `uploadCustomProfile(brf)` → envoie en POST un texte BRF complet, renvoie
 *    l'identifiant `custom_<id>` à utiliser dans les appels de routage suivants.
 */
import {
  type BrouterRequest,
  type BrouterRoute,
  type UploadedProfile,
} from '../types';
import { buildBrouterUrl, buildProfileUploadUrl } from './url';
import { recordObservedCostScale } from './searchCoefficient';
import { delay, isWatchdogMessage, num, WATCHDOG_RETRY_DELAYS_MS } from './brouterScoring';

interface BrouterFeatureProps {
  'track-length'?: string;
  'total-time'?: string;
  'filtered ascend'?: string;
  'plain-ascend'?: string;
  [k: string]: unknown;
}

const clientRouteCache = new Map<string, BrouterRoute>();
const MAX_CLIENT_CACHE = 256;

/**
 * Quota de requêtes du proxy /api/brouter atteint (HTTP 429). À ne jamais
 * réessayer en boucle ni contourner par d'autres requêtes : on s'arrête et on
 * le signale à l'utilisateur.
 */
export class BrouterRateLimitError extends Error {
  /** Délai conseillé par l'en-tête Retry-After, en secondes (null si absent). */
  readonly retryAfterS: number | null;

  constructor(message: string, retryAfterS: number | null) {
    super(message);
    this.name = 'BrouterRateLimitError';
    this.retryAfterS = retryAfterS;
  }
}

export function isBrouterRateLimitError(error: unknown): error is BrouterRateLimitError {
  return error instanceof BrouterRateLimitError;
}

function parseRetryAfterS(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, Math.round((dateMs - Date.now()) / 1000)) : null;
}

/**
 * Demande un tracé à BRouter. Lève une erreur sur les erreurs réseau/HTTP et sur
 * les erreurs côté BRouter (renvoyées en réponses texte brut commençant par
 * `"error"` — on les détecte par le Content-Type).
 */
export async function fetchBrouterRoute(
  req: BrouterRequest,
): Promise<BrouterRoute> {
  const url = buildBrouterUrl(req);
  if (clientRouteCache.has(url)) {
    return clientRouteCache.get(url)!;
  }
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= WATCHDOG_RETRY_DELAYS_MS.length; attempt += 1) {
    const res = await fetch(url, {
      method: 'GET',
      signal: req.signal,
      headers: { Accept: 'application/json,application/geo+json,text/plain' },
    });
    req.onResponseHeaders?.();

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const upstream = res.headers.get('x-brouter-upstream-error');
      const detail = text || upstream || '';
      const message = `BRouter HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${
        detail ? ` — ${detail.slice(0, 300)}` : ''
      }`;
      if (res.status === 429) {
        throw new BrouterRateLimitError(message, parseRetryAfterS(res.headers.get('retry-after')));
      }
      lastError = new Error(message);
      if (isWatchdogMessage(lastError.message) && attempt < WATCHDOG_RETRY_DELAYS_MS.length) {
        await delay(WATCHDOG_RETRY_DELAYS_MS[attempt]!, req.signal);
        continue;
      }
      throw lastError;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const body = await res.text();
    if (!contentType.includes('json') || body.trim().startsWith('error')) {
      lastError = new Error(`BRouter: ${body.trim().slice(0, 300)}`);
      if (isWatchdogMessage(lastError.message) && attempt < WATCHDOG_RETRY_DELAYS_MS.length) {
        await delay(WATCHDOG_RETRY_DELAYS_MS[attempt]!, req.signal);
        continue;
      }
      throw lastError;
    }

    let json: GeoJSON.FeatureCollection;
    try {
      json = JSON.parse(body) as GeoJSON.FeatureCollection;
    } catch (e) {
      throw new Error(
        `BRouter: réponse invalide (${(e as Error).message}). Début: ${body.slice(0, 120)}`,
      );
    }

    const feature = json.features?.[0];
    if (!feature || feature.geometry?.type !== 'LineString') {
      throw new Error('BRouter: aucune trace renvoyée pour ces points.');
    }

    const coords = feature.geometry.coordinates as [number, number][];
    const props = (feature.properties ?? {}) as BrouterFeatureProps;

    const route: BrouterRoute = {
      coordinates: coords,
      distanceM: num(props['track-length']),
      durationS: num(props['total-time']),
      ascentM: num(props['filtered ascend']),
      // `plain-ascend` = dénivelé net (arrivée − départ) : D− = D+ − net.
      descentM: Math.max(0, num(props['filtered ascend']) - num(props['plain-ascend'])),
      raw: json,
    };

    recordObservedCostScale(req.profile, num(props.cost), route.distanceM);

    if (clientRouteCache.size >= MAX_CLIENT_CACHE) {
      const oldestKey = clientRouteCache.keys().next().value;
      if (oldestKey !== undefined) clientRouteCache.delete(oldestKey);
    }
    clientRouteCache.set(url, route);

    return route;
  }
  throw lastError ?? new Error('BRouter: route fetch failed after watchdog retries');
}

/**
 * Envoie un profil BRF personnalisé. Le serveur le compile et renvoie un id
 * `custom_<hash>` (dérivé du contenu du profil) à repasser en `?profile=...`.
 */
export async function uploadCustomProfile(
  brf: string,
  signal?: AbortSignal,
): Promise<UploadedProfile> {
  const url = buildProfileUploadUrl();
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    body: brf,
  });
  const text = await res.text();
  if (!res.ok) {
    const message = `BRouter upload HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`;
    if (res.status === 429) {
      throw new BrouterRateLimitError(message, parseRetryAfterS(res.headers.get('retry-after')));
    }
    throw new Error(message);
  }
  let parsed: { profileid?: string; error?: string };
  try {
    parsed = JSON.parse(text) as { profileid?: string; error?: string };
  } catch {
    throw new Error(`BRouter upload: réponse invalide — ${text.slice(0, 200)}`);
  }
  if (!parsed.profileid) {
    throw new Error(`BRouter upload: pas de profileid — ${text.slice(0, 200)}`);
  }
  return { profileId: parsed.profileid, error: parsed.error };
}

