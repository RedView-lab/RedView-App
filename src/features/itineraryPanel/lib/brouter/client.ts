/**
 * BRouter HTTP client — fetchers.
 *
 * Two operations:
 *  - `fetchBrouterRoute(req)` → routes a query, returns parsed metadata.
 *  - `uploadCustomProfile(brf)` → POSTs a full BRF text, returns the
 *    `custom_<id>` handle to use in subsequent routing calls.
 */
import {
  type BrouterRequest,
  type BrouterRoute,
  type UploadedProfile,
} from './types';
import { buildBrouterUrl, buildProfileUploadUrl } from './url';
interface BrouterFeatureProps {
  'track-length'?: string;
  'total-time'?: string;
  'filtered ascend'?: string;
  'plain-ascend'?: string;
  [k: string]: unknown;
}

function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Fetch a route from BRouter. Throws on network/HTTP errors and on
 * BRouter-side errors (which are returned as plain-text responses
 * starting with `"error"` — we detect them via Content-Type).
 */
export async function fetchBrouterRoute(
  req: BrouterRequest,
): Promise<BrouterRoute> {
  const url = buildBrouterUrl(req);
  const res = await fetch(url, {
    method: 'GET',
    signal: req.signal,
    headers: { Accept: 'application/json,application/geo+json,text/plain' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const upstream = res.headers.get('x-brouter-upstream-error');
    const detail = text || upstream || '';
    throw new Error(
      `BRouter HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${
        detail ? ` — ${detail.slice(0, 300)}` : ''
      }`,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  const body = await res.text();

  if (!contentType.includes('json') || body.trim().startsWith('error')) {
    throw new Error(`BRouter: ${body.trim().slice(0, 300)}`);
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

  return {
    coordinates: coords,
    distanceM: num(props['track-length']),
    durationS: num(props['total-time']),
    ascentM: num(props['filtered ascend']),
    descentM: num(props['plain-ascend']) - num(props['filtered ascend']),
    raw: json,
  };
}

/**
 * Upload a custom BRF profile. The server compiles it and returns a
 * `custom_<timestamp>` id we can pass back as `?profile=...`. If `updateId`
 * is provided, the existing profile is overwritten in place (useful when
 * the user iterates in Expert Mode).
 */
export async function uploadCustomProfile(
  brf: string,
  updateId?: string,
  signal?: AbortSignal,
): Promise<UploadedProfile> {
  const url = buildProfileUploadUrl(updateId);
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    body: brf,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `BRouter upload HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`,
    );
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
/* ------------------------------------------------------------------ */
/* Best-of-N alternative routing (climb-seeker mode)                   */
/* ------------------------------------------------------------------ */

/**
 * Run BRouter `numAlternatives` times with `alternativeidx` 0..N-1 and
 * return whichever alternative climbs the most. Ported verbatim from
 * earth-explorer-3d's `callBRouterBestOfN` (`server/routes/brouter.ts`).
 *
 * BRouter standalone exposes 4 alternatives (idx 0..3). Asking for a
 * higher idx is harmless — it just returns the same as idx=3. We default
 * to 4 so we get the full spread.
 *
 * Failed alternatives are silently skipped; if every attempt fails the
 * last error is rethrown.
 */
export async function fetchBrouterRouteBestOfN(
  req: Omit<BrouterRequest, 'alternativeIdx'>,
  numAlternatives = 4,
): Promise<BrouterRoute> {
  const n = Math.max(1, Math.min(4, Math.floor(numAlternatives)));
  const attempts = Array.from({ length: n }, (_, i) =>
    fetchBrouterRoute({ ...req, alternativeIdx: i as 0 | 1 | 2 | 3 }).then(
      (r) => ({ ok: true as const, route: r, idx: i }),
      (e) => ({ ok: false as const, error: e as Error, idx: i }),
    ),
  );
  const results = await Promise.all(attempts);

  let best: BrouterRoute | null = null;
  let bestIdx = -1;
  let lastError: Error | null = null;
  for (const r of results) {
    if (!r.ok) {
      lastError = r.error;
      continue;
    }
    if (!best || r.route.ascentM > best.ascentM) {
      best = r.route;
      bestIdx = r.idx;
    }
  }
  if (!best) {
    throw lastError ?? new Error('BRouter best-of-N: every alternative failed');
  }
  // Tag the chosen idx on the result for diagnostics (tests log this).
  (best as BrouterRoute & { alternativeIdx?: number }).alternativeIdx = bestIdx;
  return best;
}