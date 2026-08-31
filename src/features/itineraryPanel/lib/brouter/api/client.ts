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
} from '../types';
import { buildBrouterUrl, buildProfileUploadUrl } from './url';
import {
  delay,
  isExpectedDetourCandidateFailure,
  isWatchdogMessage,
  num,
  scoreMinDistanceMaxAscent,
  computeClimbEfficiency,
  WATCHDOG_RETRY_DELAYS_MS,
} from './brouterScoring';
import {
  buildClimbEfficiencyDetourCandidates,
  buildDistanceDetourCandidates,
} from './brouterDetourOptimizer';
import { logger } from '@/shared/lib/logger';

interface BrouterFeatureProps {
  'track-length'?: string;
  'total-time'?: string;
  'filtered ascend'?: string;
  'plain-ascend'?: string;
  [k: string]: unknown;
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
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= WATCHDOG_RETRY_DELAYS_MS.length; attempt += 1) {
    const res = await fetch(url, {
      method: 'GET',
      signal: req.signal,
      headers: { Accept: 'application/json,application/geo+json,text/plain' },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const upstream = res.headers.get('x-brouter-upstream-error');
      const detail = text || upstream || '';
      lastError = new Error(
        `BRouter HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${
          detail ? ` — ${detail.slice(0, 300)}` : ''
        }`,
      );
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

    return {
      coordinates: coords,
      distanceM: num(props['track-length']),
      durationS: num(props['total-time']),
      ascentM: num(props['filtered ascend']),
      descentM: num(props['plain-ascend']) - num(props['filtered ascend']),
      raw: json,
    };
  }
  throw lastError ?? new Error('BRouter: route fetch failed after watchdog retries');
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

export async function fetchBrouterRouteBestOfN(
  req: Omit<BrouterRequest, 'alternativeIdx'>,
  numAlternatives = 4,
): Promise<BrouterRoute> {
  return fetchBrouterRouteBestByScore(
    req,
    (route) => route.ascentM,
    'max ascent',
    numAlternatives,
  );
}

export async function fetchBrouterRouteBestByScore(
  req: Omit<BrouterRequest, 'alternativeIdx'>,
  scoreRoute: (route: BrouterRoute) => number,
  label = 'custom score',
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
  let bestScore = -Infinity;
  let lastError: Error | null = null;
  for (const r of results) {
    if (!r.ok) {
      lastError = r.error;
      logger.brouter.warn(
        `best-of-N: alt ${r.idx} failed —`,
        r.error.message,
      );
      continue;
    }
    logger.brouter.debug(
      `best-of-N: alt ${r.idx} OK — ascent=${Math.round(r.route.ascentM)} m, dist=${(r.route.distanceM / 1000).toFixed(1)} km`,
    );
    const score = scoreRoute(r.route);
    if (Number.isFinite(score) && score > bestScore) {
      best = r.route;
      bestIdx = r.idx;
      bestScore = score;
    }
  }
  if (!best) {
    throw lastError ?? new Error('BRouter best-of-N: every alternative failed');
  }
  logger.brouter.debug(`best-of-N: picked alt ${bestIdx} (${label}, score=${bestScore.toFixed(2)})`);
  (best as BrouterRoute & { alternativeIdx?: number }).alternativeIdx = bestIdx;
  return best;
}

export async function fetchBrouterRouteBestWithDistanceDetours(
  req: Omit<BrouterRequest, 'alternativeIdx'>,
  scoreRoute: (route: BrouterRoute) => number,
  label: string,
  distanceFocus: number,
  climbFocus: number,
  numBaseAlternatives = 4,
): Promise<BrouterRoute> {
  let best: BrouterRoute | null = null;
  let baseRoute: BrouterRoute | null = null;
  let bestLabel = '';
  let bestScore = -Infinity;
  let lastError: Error | null = null;

  const consider = (route: BrouterRoute, candidateLabel: string) => {
    const score = scoreRoute(route);
    logger.brouter.debug(
      `distance detour ${candidateLabel} OK — score=${score.toFixed(2)}, ascent=${Math.round(route.ascentM)} m, dist=${(route.distanceM / 1000).toFixed(1)} km`,
    );
    if (Number.isFinite(score) && score > bestScore) {
      best = route;
      bestLabel = candidateLabel;
      bestScore = score;
    }
  };

  try {
    const alternatives = await fetchBrouterRouteBestByScore(req, scoreRoute, label, numBaseAlternatives);
    baseRoute = alternatives;
    consider(alternatives, 'alternatives');
  } catch (error) {
    lastError = error as Error;
    logger.brouter.warn('distance detour alternatives failed —', lastError.message);
    try {
      const fallbackRoute = await fetchBrouterRoute({ ...req, alternativeIdx: 0 });
      baseRoute = fallbackRoute;
      consider(fallbackRoute, 'direct-fallback');
    } catch (fallbackError) {
      lastError = fallbackError as Error;
      logger.brouter.warn('distance detour direct fallback failed —', lastError.message);
    }
  }

  for (const candidate of buildDistanceDetourCandidates(req, distanceFocus, climbFocus, baseRoute)) {
    try {
      consider(await fetchBrouterRoute({ ...req, via: candidate.via }), candidate.label);
    } catch (error) {
      lastError = error as Error;
      if (!isExpectedDetourCandidateFailure(lastError)) {
        logger.brouter.warn(`distance detour ${candidate.label} failed —`, lastError.message);
      }
    }
  }
  if (!best) throw lastError ?? new Error('BRouter distance detours: every candidate failed');
  logger.brouter.debug(`distance detour picked ${bestLabel} (${label}, score=${bestScore.toFixed(2)})`);
  return best;
}

export async function fetchBrouterRouteBestWithClimbEfficiency(
  req: Omit<BrouterRequest, 'alternativeIdx'>,
): Promise<BrouterRoute> {
  const directBase = await fetchBrouterRoute({ ...req, alternativeIdx: 0 });
  let best: BrouterRoute = directBase;
  let bestLabel = 'direct-alt-0';
  let bestScore = scoreMinDistanceMaxAscent(directBase, directBase);

  const consider = (route: BrouterRoute, candidateLabel: string) => {
    const score = scoreMinDistanceMaxAscent(route, directBase);
    const efficiency = computeClimbEfficiency(route, directBase);
    logger.brouter.debug(
      `climb-efficiency ${candidateLabel} OK — score=${score.toFixed(2)}, gain=${Math.round(efficiency.addedAscentM)} m, extra=${efficiency.addedDistanceKm.toFixed(1)} km, gain/km=${efficiency.gainPerAddedKm.toFixed(1)}`,
    );
    if (Number.isFinite(score) && score > bestScore) {
      best = route;
      bestLabel = candidateLabel;
      bestScore = score;
    }
  };

  if ((req.via?.length ?? 0) > 0) {
    for (const alternativeIdx of [1, 2, 3] as const) {
      try {
        consider(await fetchBrouterRoute({ ...req, alternativeIdx }), `direct-alt-${alternativeIdx}`);
      } catch (error) {
        logger.brouter.warn(`climb-efficiency direct alt ${alternativeIdx} failed —`, (error as Error).message);
      }
    }
    logger.brouter.debug(`climb-efficiency picked ${bestLabel} (score=${bestScore.toFixed(2)})`);
    return best;
  }

  for (const candidate of buildClimbEfficiencyDetourCandidates(req, directBase)) {
    for (const alternativeIdx of candidate.alternativeIdxs) {
      try {
        consider(
          await fetchBrouterRoute({
            ...req,
            via: candidate.via,
            alternativeIdx,
          }),
          `${candidate.label}-alt${alternativeIdx}`,
        );
      } catch (error) {
        const routeError = error as Error;
        if (!isExpectedDetourCandidateFailure(routeError)) {
          logger.brouter.warn(`climb-efficiency ${candidate.label} alt ${alternativeIdx} failed —`, routeError.message);
        }
      }
    }
  }

  logger.brouter.debug(`climb-efficiency picked ${bestLabel} (score=${bestScore.toFixed(2)})`);
  return best;
}