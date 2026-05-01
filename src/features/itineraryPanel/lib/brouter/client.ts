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

const WATCHDOG_RETRY_DELAYS_MS = [250, 700, 1500];

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

function isWatchdogMessage(message: string): boolean {
  return /thread-priority-watchdog/i.test(message);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function buildDetourPoint(
  anchor: BrouterRequest['start'],
  tangentStart: BrouterRequest['start'],
  tangentEnd: BrouterRequest['start'],
  offsetKm: number,
): BrouterRequest['start'] {
  const meanLatRad = (((tangentStart.lat + tangentEnd.lat) / 2) * Math.PI) / 180;
  const kmPerDegLon = Math.max(25, 111.32 * Math.cos(meanLatRad));
  const kmPerDegLat = 110.57;
  const dxKm = (tangentEnd.lon - tangentStart.lon) * kmPerDegLon;
  const dyKm = (tangentEnd.lat - tangentStart.lat) * kmPerDegLat;
  const lengthKm = Math.max(1, Math.hypot(dxKm, dyKm));
  const perpX = -dyKm / lengthKm;
  const perpY = dxKm / lengthKm;
  return {
    lat: Math.max(-85, Math.min(85, anchor.lat + ((perpY * offsetKm) / kmPerDegLat))),
    lon: Math.max(-180, Math.min(180, anchor.lon + ((perpX * offsetKm) / kmPerDegLon))),
  };
}

function pointDistanceKm(a: BrouterRequest['start'], b: BrouterRequest['start']): number {
  const radiusKm = 6371;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = (sinLat * sinLat) + (Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon);
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

function toRoutePoint(coord: [number, number]): BrouterRequest['start'] {
  return { lon: coord[0], lat: coord[1] };
}

function sampleRouteAnchor(
  coordinates: [number, number][],
  along: number,
): { anchor: BrouterRequest['start']; tangentStart: BrouterRequest['start']; tangentEnd: BrouterRequest['start'] } | null {
  if (coordinates.length < 2) return null;
  const routePoints = coordinates.map(toRoutePoint);
  const clampedAlong = Math.max(0.02, Math.min(0.98, along));
  let totalKm = 0;
  const cumulativeKm = [0];
  for (let i = 1; i < routePoints.length; i++) {
    totalKm += pointDistanceKm(routePoints[i - 1], routePoints[i]);
    cumulativeKm.push(totalKm);
  }
  if (totalKm <= 0) return null;
  const targetKm = totalKm * clampedAlong;
  for (let i = 1; i < routePoints.length; i++) {
    const segStartKm = cumulativeKm[i - 1];
    const segEndKm = cumulativeKm[i];
    if (targetKm > segEndKm && i < routePoints.length - 1) continue;
    const segmentKm = Math.max(0.001, segEndKm - segStartKm);
    const segAlong = Math.max(0, Math.min(1, (targetKm - segStartKm) / segmentKm));
    const start = routePoints[i - 1];
    const end = routePoints[i];
    return {
      anchor: {
        lat: start.lat + ((end.lat - start.lat) * segAlong),
        lon: start.lon + ((end.lon - start.lon) * segAlong),
      },
      tangentStart: start,
      tangentEnd: end,
    };
  }
  return null;
}

function isExpectedDetourCandidateFailure(error: Error): boolean {
  return /via\d+-position not mapped|error re-tracking track/i.test(error.message);
}

function estimateRouteSpanKm(
  start: BrouterRequest['start'],
  end: BrouterRequest['end'],
): number {
  const meanLatRad = (((start.lat + end.lat) / 2) * Math.PI) / 180;
  const dxKm = (end.lon - start.lon) * Math.max(25, 111.32 * Math.cos(meanLatRad));
  const dyKm = (end.lat - start.lat) * 110.57;
  return Math.max(1, Math.hypot(dxKm, dyKm));
}

function normalizeDetourRatios(values: number[]): number[] {
  const seen = new Set<number>();
  const ratios: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const normalized = Math.round(Math.max(0.06, Math.min(0.56, value)) * 1000) / 1000;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ratios.push(normalized);
  }
  return ratios;
}

function buildDistanceDetourCandidates(
  req: Omit<BrouterRequest, 'alternativeIdx'>,
  distanceFocus: number,
  climbFocus: number,
  baseRoute: BrouterRoute | null,
): Array<{ via: BrouterRequest['via']; label: string }> {
  if ((req.via?.length ?? 0) > 0 || !baseRoute || baseRoute.coordinates.length < 2) return [];
  const spanKm = estimateRouteSpanKm(req.start, req.end);
  const focusSum = distanceFocus + climbFocus;
  const isDistanceOnly = climbFocus < 0.25;
  const isExtremeClimbDistance = !isDistanceOnly && distanceFocus >= 0.9 && climbFocus >= 0.9;
  const isExtremeDistanceOnly = isDistanceOnly && distanceFocus >= 0.9;
  const buildCandidatesFromSpecs = (
    specs: Array<{ label: string; ratio: number; points: readonly (readonly [number, number])[] }>,
  ): Array<{ via: BrouterRequest['via']; label: string }> => {
    return specs.flatMap((spec) => {
      const offsetKm = spanKm * spec.ratio;
      const via = spec.points.map(([along, offset]) => {
        const anchor = sampleRouteAnchor(baseRoute.coordinates, along);
        if (!anchor) return null;
        return buildDetourPoint(anchor.anchor, anchor.tangentStart, anchor.tangentEnd, offsetKm * offset);
      });
      return via.some((point) => point == null)
        ? []
        : [{ label: spec.label, via: via as BrouterRequest['via'] }];
    });
  };
  const ultraWideRatio = !isDistanceOnly && focusSum >= 1.35
    ? 0.16 + (distanceFocus * 0.08) + (climbFocus * 0.1)
    : Number.NaN;
  const detourRatios = isDistanceOnly
    ? normalizeDetourRatios([
        0.045 + (distanceFocus * 0.035),
        0.085 + (distanceFocus * 0.07),
        0.135 + (distanceFocus * 0.105),
      ])
    : normalizeDetourRatios([
        0.06 + (distanceFocus * 0.04) + (climbFocus * 0.03),
        0.11 + (distanceFocus * 0.07) + (climbFocus * 0.06),
        ultraWideRatio,
      ]);
  const basePatterns = [
    { label: 'detour-left-early', points: [[0.33, 1]] },
    { label: 'detour-right-early', points: [[0.33, -1]] },
    { label: 'detour-left-mid', points: [[0.5, 1]] },
    { label: 'detour-right-mid', points: [[0.5, -1]] },
    { label: 'detour-left-late', points: [[0.67, 1]] },
    { label: 'detour-right-late', points: [[0.67, -1]] },
  ] as const;
  const complexPatterns = [
    { label: 's-curve-left-right', points: [[0.34, 1], [0.66, -1]] },
    { label: 's-curve-right-left', points: [[0.34, -1], [0.66, 1]] },
    { label: 'zigzag-left', points: [[0.25, 0.72], [0.5, -0.92], [0.75, 0.72]] },
    { label: 'zigzag-right', points: [[0.25, -0.72], [0.5, 0.92], [0.75, -0.72]] },
  ] as const;
  if (isExtremeClimbDistance) {
    const ultraRatio = Math.min(0.5, Math.max(detourRatios[2] ?? 0.34, 0.34) + 0.12);
    return buildCandidatesFromSpecs([
      { label: 'alpine-zigzag-left-r5', ratio: ultraRatio, points: [[0.16, 0.92], [0.36, -1.18], [0.58, 1.25], [0.8, -1.02]] },
      { label: 'alpine-zigzag-right-r5', ratio: ultraRatio, points: [[0.16, -0.92], [0.36, 1.18], [0.58, -1.25], [0.8, 1.02]] },
      { label: 'alpine-crown-left-r5', ratio: ultraRatio, points: [[0.2, 1.05], [0.42, -1.28], [0.64, 1.28], [0.84, -1.05]] },
      { label: 'alpine-crown-right-r5', ratio: ultraRatio, points: [[0.2, -1.05], [0.42, 1.28], [0.64, -1.28], [0.84, 1.05]] },
    ]);
  }
  if (isExtremeDistanceOnly) {
    const [, , ultraRatio = 0.24] = detourRatios;
    const hyperRatio = Math.min(0.5, Math.max(ultraRatio + 0.16, 0.42));
    return buildCandidatesFromSpecs([
      { label: 'zigzag-left-r4', ratio: hyperRatio, points: [[0.2, 0.96], [0.5, -1.2], [0.8, 0.96]] },
      { label: 'zigzag-right-r4', ratio: hyperRatio, points: [[0.2, -0.96], [0.5, 1.2], [0.8, -0.96]] },
      { label: 'crown-left-r4', ratio: hyperRatio, points: [[0.18, 1.05], [0.4, -1.28], [0.62, 1.28], [0.84, -1.05]] },
      { label: 'crown-right-r4', ratio: hyperRatio, points: [[0.18, -1.05], [0.4, 1.28], [0.62, -1.28], [0.84, 1.05]] },
    ]);
  }
  const patterns = isDistanceOnly ? basePatterns : [...basePatterns, ...complexPatterns];

  return detourRatios.flatMap((ratio, ratioIndex) => {
    const offsetKm = spanKm * ratio;
    return patterns.flatMap((pattern) => {
      const via = pattern.points.map(([along, offset]) => {
        const anchor = sampleRouteAnchor(baseRoute.coordinates, along);
        if (!anchor) return null;
        return buildDetourPoint(anchor.anchor, anchor.tangentStart, anchor.tangentEnd, offsetKm * offset);
      });
      return via.some((point) => point == null)
        ? []
        : [{ label: `${pattern.label}-r${ratioIndex + 1}`, via: via as BrouterRequest['via'] }];
    });
  });
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
        await delay(WATCHDOG_RETRY_DELAYS_MS[attempt], req.signal);
        continue;
      }
      throw lastError;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const body = await res.text();
    if (!contentType.includes('json') || body.trim().startsWith('error')) {
      lastError = new Error(`BRouter: ${body.trim().slice(0, 300)}`);
      if (isWatchdogMessage(lastError.message) && attempt < WATCHDOG_RETRY_DELAYS_MS.length) {
        await delay(WATCHDOG_RETRY_DELAYS_MS[attempt], req.signal);
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
      console.warn(
        `[BRouter] best-of-N: alt ${r.idx} failed —`,
        r.error.message,
      );
      continue;
    }
    console.log(
      `[BRouter] best-of-N: alt ${r.idx} OK — ascent=${Math.round(r.route.ascentM)} m, dist=${(r.route.distanceM / 1000).toFixed(1)} km`,
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
  console.log(`[BRouter] best-of-N: picked alt ${bestIdx} (${label}, score=${bestScore.toFixed(2)})`);
  // Tag the chosen idx on the result for diagnostics (tests log this).
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
    console.log(
      `[BRouter] distance detour ${candidateLabel} OK — score=${score.toFixed(2)}, ascent=${Math.round(route.ascentM)} m, dist=${(route.distanceM / 1000).toFixed(1)} km`,
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
    console.warn('[BRouter] distance detour alternatives failed —', lastError.message);
    try {
      const fallbackRoute = await fetchBrouterRoute({ ...req, alternativeIdx: 0 });
      baseRoute = fallbackRoute;
      consider(fallbackRoute, 'direct-fallback');
    } catch (fallbackError) {
      lastError = fallbackError as Error;
      console.warn('[BRouter] distance detour direct fallback failed —', lastError.message);
    }
  }

  for (const candidate of buildDistanceDetourCandidates(req, distanceFocus, climbFocus, baseRoute)) {
    try {
      consider(await fetchBrouterRoute({ ...req, via: candidate.via }), candidate.label);
    } catch (error) {
      lastError = error as Error;
      if (!isExpectedDetourCandidateFailure(lastError)) {
        console.warn(`[BRouter] distance detour ${candidate.label} failed —`, lastError.message);
      }
    }
  }
  if (!best) throw lastError ?? new Error('BRouter distance detours: every candidate failed');
  console.log(`[BRouter] distance detour picked ${bestLabel} (${label}, score=${bestScore.toFixed(2)})`);
  return best;
}