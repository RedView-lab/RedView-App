/**
 * Comprehensive scenario tests for the BRF generator + upload pipeline.
 *
 *   npx tsx scripts/test-brouter-scenarios.ts
 */
import { buildBrfProfile } from '../src/features/itineraryPanel/lib/brouter/brf-template';
import { isClimbingMode } from '../src/features/itineraryPanel/lib/brouter/climb-mode';
import type {
  PrioritiesState,
  RoadTypesState,
} from '../src/features/itineraryPanel/types';

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { _flush?: () => void };
  exitCode?: number;
  exit(code?: number): never;
};

const UPSTREAM =
  process.env.BROUTER_UPSTREAM?.replace(/\/+$/, '') ?? 'http://localhost:17777';
const WATCHDOG_RETRY_DELAYS_MS = [250, 700, 1500];
const ONLY_GROUPS = new Set(
  (process.env.BROUTER_BENCH_GROUPS ?? '')
    .split(',')
    .map((group: string) => group.trim().toUpperCase())
    .filter(Boolean),
);

const PT = {
  chamonix: { lat: 45.9237, lon: 6.8694 },
  grenoble: { lat: 45.1885, lon: 5.7245 },
  autun: { lat: 46.9517, lon: 4.2994 },
  clamecy: { lat: 47.4608, lon: 3.5203 },
} as const;

interface BenchRoute {
  from: Point;
  to: Point;
  label: string;
}

const DEFAULT_ROUTE: BenchRoute = { from: PT.chamonix, to: PT.grenoble, label: 'Chamonix → Grenoble (Alps)' };
const MORVAN_ROUTE: BenchRoute = { from: PT.autun, to: PT.clamecy, label: 'Autun → Clamecy (Morvan)' };

type Point = { lat: number; lon: number };

const NEUTRAL_PRIORITIES: PrioritiesState = {
  duration: 50, elevation: 50, distance: 50, tranquility: 50,
};

function rt(over: Partial<RoadTypesState> = {}): RoadTypesState {
  return {
    road: 'tolerate', gravel: 'tolerate', singletrack: 'tolerate',
    offroad: 'tolerate', bikeLanes: 'tolerate', majorRoads: 'tolerate',
    ferry: 'tolerate', turns: 'tolerate', cities: 'tolerate',
    maxSlopePercent: 99, applyToAllItineraries: false,
    ...over,
  };
}

function pri(over: Partial<PrioritiesState> = {}): PrioritiesState {
  return { ...NEUTRAL_PRIORITIES, ...over };
}

interface RouteStats {
  distanceKm: number;
  ascentM: number;
  descentM: number;
  durationMin: number;
  tortuosity: number;
  status: number;
  profileId: string;
  coordinates?: [number, number][];
  error?: string;
}

function formatError(error: unknown): string {
  const err = error as { message?: string; cause?: { code?: string; message?: string } };
  const message = err?.message ?? String(error);
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause ? `${message} (${cause})` : message;
}

function isWatchdogMessage(message: string): boolean {
  return /thread-priority-watchdog/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function haversineKm(a: Point, b: Point): number {
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

function buildDetourPoint(start: Point, end: Point, along: number, offsetKm: number): Point {
  const meanLatRad = (((start.lat + end.lat) / 2) * Math.PI) / 180;
  const kmPerDegLon = Math.max(25, 111.32 * Math.cos(meanLatRad));
  const kmPerDegLat = 110.57;
  const dxKm = (end.lon - start.lon) * kmPerDegLon;
  const dyKm = (end.lat - start.lat) * kmPerDegLat;
  const lengthKm = Math.max(1, Math.hypot(dxKm, dyKm));
  const perpX = -dyKm / lengthKm;
  const perpY = dxKm / lengthKm;
  const baseLat = start.lat + ((end.lat - start.lat) * along);
  const baseLon = start.lon + ((end.lon - start.lon) * along);
  return {
    lat: Math.max(-85, Math.min(85, baseLat + ((perpY * offsetKm) / kmPerDegLat))),
    lon: Math.max(-180, Math.min(180, baseLon + ((perpX * offsetKm) / kmPerDegLon))),
  };
}

function buildAnchoredDetourPoint(anchor: Point, tangentStart: Point, tangentEnd: Point, offsetKm: number): Point {
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

function estimateRouteSpanKm(from: Point, to: Point): number {
  const meanLatRad = (((from.lat + to.lat) / 2) * Math.PI) / 180;
  const dxKm = (to.lon - from.lon) * Math.max(25, 111.32 * Math.cos(meanLatRad));
  const dyKm = (to.lat - from.lat) * 110.57;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sampleRouteAnchor(
  coordinates: [number, number][],
  along: number,
): { anchor: Point; tangentStart: Point; tangentEnd: Point } | null {
  if (coordinates.length < 2) return null;
  const routePoints = coordinates.map(([lon, lat]) => ({ lat, lon }));
  const clampedAlong = Math.max(0.02, Math.min(0.98, along));
  let totalKm = 0;
  const cumulativeKm = [0];
  for (let i = 1; i < routePoints.length; i++) {
    totalKm += haversineKm(routePoints[i - 1], routePoints[i]);
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

function computeRouteLateralBias(
  coordinates: [number, number][],
  start: Point,
  end: Point,
): number {
  const directDx = end.lon - start.lon;
  const directDy = end.lat - start.lat;
  const directNorm = Math.hypot(directDx, directDy);
  if (directNorm <= 1e-9 || coordinates.length < 2) return 0;
  const sampleAlongs = [0.36, 0.5, 0.64];
  let weightedBias = 0;
  let weightSum = 0;
  for (const along of sampleAlongs) {
    const anchor = sampleRouteAnchor(coordinates, along);
    if (!anchor) continue;
    const relDx = anchor.anchor.lon - start.lon;
    const relDy = anchor.anchor.lat - start.lat;
    const signedArea = ((directDx * relDy) - (directDy * relDx)) / directNorm;
    const weight = 1 - Math.abs(along - 0.5);
    weightedBias += signedArea * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedBias / weightSum : 0;
}

function isExpectedDetourCandidateFailure(message: string): boolean {
  return /via\d+-position not mapped|error re-tracking track/i.test(message);
}

function scoreMaxAscentLongDistance(route: RouteStats): number {
  const targetClimbDensity = 38;
  const flatGapM = Math.max(0, (route.distanceKm * targetClimbDensity) - route.ascentM);
  return (route.ascentM * 1150) + ((route.distanceKm * 1000) * 0.04) - (flatGapM * 1600);
}

function computeClimbEfficiency(
  route: RouteStats,
  baseline: RouteStats,
): { addedDistanceKm: number; addedAscentM: number; gainPerAddedKm: number } {
  const addedDistanceKm = route.distanceKm - baseline.distanceKm;
  const addedAscentM = route.ascentM - baseline.ascentM;
  const gainPerAddedKm = addedAscentM / Math.max(0.5, addedDistanceKm);
  return { addedDistanceKm, addedAscentM, gainPerAddedKm };
}

function scoreMinDistanceMaxAscent(route: RouteStats, baseline: RouteStats): number {
  const addedDistanceKm = Math.max(0, route.distanceKm - baseline.distanceKm);
  const addedAscentM = Math.max(0, route.ascentM - baseline.ascentM);
  const gainPerAddedKm = addedAscentM / Math.max(2.5, addedDistanceKm);
  const climbDensity = route.ascentM / Math.max(1, route.distanceKm);
  const softBudgetKm = Math.max(8, baseline.distanceKm * 0.08);
  const overBudgetKm = Math.max(0, addedDistanceKm - softBudgetKm);
  return (
    (gainPerAddedKm * 5200)
    + (addedAscentM * 6)
    + (climbDensity * 180)
    - (addedDistanceKm * 140)
    - (overBudgetKm * overBudgetKm * 280)
  );
}

function buildClimbEfficiencyDetourCandidates(
  from: Point,
  to: Point,
  baseRoute: RouteStats,
): Array<{ via: Point[]; label: string; alternativeIdxs: readonly (0 | 1 | 2 | 3)[] }> {
  if (!baseRoute.coordinates || baseRoute.coordinates.length < 2) return [];
  const spanKm = estimateRouteSpanKm(from, to);
  const baseClimbDensity = baseRoute.ascentM / Math.max(1, baseRoute.distanceKm);
  const densityBoost = clamp((28 - baseClimbDensity) / 20, 0, 1);
  const tortuosity = baseRoute.distanceKm / Math.max(1, haversineKm(from, to));
  const compactness = clamp((tortuosity - 1.02) / 0.22, 0, 1);
  const scale = 1 + (densityBoost * 0.7) - (compactness * 0.18);
  const searchBreadth = clamp(0.28 + (densityBoost * 0.78) - (compactness * 0.18), 0.2, 1);
  const sideBias = computeRouteLateralBias(baseRoute.coordinates, from, to);
  const preferredSign = Math.abs(sideBias) < 1e-4 ? -1 : (sideBias > 0 ? -1 : 1);
  const hedgeSign = -preferredSign;
  const buildCandidate = (
    label: string,
    ratio: number,
    points: readonly (readonly [number, number])[],
    sign: number,
    alternativeIdxs: readonly (0 | 1 | 2 | 3)[],
  ): { via: Point[]; label: string; alternativeIdxs: readonly (0 | 1 | 2 | 3)[] } | null => {
    const offsetKm = spanKm * clamp(ratio * scale * (1 + (searchBreadth * 0.08)), 0.012, 0.058);
    const via = points.map(([along, offset]) => {
      const anchor = sampleRouteAnchor(baseRoute.coordinates ?? [], along);
      if (!anchor) return null;
      return buildAnchoredDetourPoint(anchor.anchor, anchor.tangentStart, anchor.tangentEnd, offsetKm * offset * sign);
    });
    if (via.some((point) => point == null)) return null;
    return { label, via: via as Point[], alternativeIdxs };
  };
  const preferMirrorProbe = Math.abs(sideBias) < 0.0012 || searchBreadth > 0.72;
  const shouldProbeWideSweep = searchBreadth > 0.42;
  const shouldProbeCrown = searchBreadth > 0.6;
  const shouldProbeZigzag = searchBreadth > 0.74;

  return [
    buildCandidate('adaptive-mid-tight', 0.017, [[0.5, 1]], preferredSign, [0, 1]),
    buildCandidate(
      'adaptive-mid-boost',
      0.023 + (densityBoost * 0.004),
      [[0.5, 1.12]],
      preferredSign,
      searchBreadth > 0.55 ? [0, 1, 2] : [0, 1],
    ),
    buildCandidate(
      'adaptive-mid-double',
      0.022 + (densityBoost * 0.004),
      [[0.46, 0.68], [0.6, 1.02]],
      preferredSign,
      [0, 1],
    ),
    shouldProbeWideSweep
      ? buildCandidate(
          'adaptive-early-late-sweep',
          0.021 + (densityBoost * 0.003),
          [[0.34, 0.66], [0.68, 1.02]],
          preferredSign,
          [0, 1],
        )
      : null,
    shouldProbeCrown
      ? buildCandidate(
          'adaptive-mid-crown',
          0.027 + (densityBoost * 0.005),
          [[0.32, 0.62], [0.5, -0.84], [0.72, 0.7]],
          preferredSign,
          [0, 1, 2],
        )
      : null,
    preferMirrorProbe
      ? buildCandidate(
          'adaptive-mid-hedge',
          0.021 + (densityBoost * 0.003),
          [[0.5, 0.98]],
          hedgeSign,
          [0, 1],
        )
      : null,
    searchBreadth > 0.58
      ? buildCandidate(
          'adaptive-hedge-sweep',
          0.023 + (densityBoost * 0.004),
          [[0.38, 0.74], [0.64, 1.02]],
          hedgeSign,
          [0, 1],
        )
      : null,
    shouldProbeZigzag
      ? buildCandidate(
          'adaptive-mid-zigzag',
          0.026 + (densityBoost * 0.004),
          [[0.28, 0.58], [0.52, 1.02], [0.76, 0.7]],
          preferredSign,
          [0, 1],
        )
      : null,
  ].filter((candidate): candidate is { via: Point[]; label: string; alternativeIdxs: readonly (0 | 1 | 2 | 3)[] } => candidate != null);
}

function buildDistanceDetourCandidates(
  from: Point,
  to: Point,
  distanceFocus: number,
  climbFocus: number,
  baseRoute: RouteStats | null,
): Array<{ via: Point[]; label: string }> {
  if (!baseRoute?.coordinates || baseRoute.coordinates.length < 2) return [];
  const spanKm = estimateRouteSpanKm(from, to);
  const focusSum = distanceFocus + climbFocus;
  const isDistanceOnly = climbFocus < 0.25;
  const isExtremeClimbDistance = !isDistanceOnly && distanceFocus >= 0.9 && climbFocus >= 0.9;
  const isExtremeDistanceOnly = isDistanceOnly && distanceFocus >= 0.9;
  const buildCandidatesFromSpecs = (
    specs: Array<{ label: string; ratio: number; points: readonly (readonly [number, number])[] }>,
  ): Array<{ via: Point[]; label: string }> => {
    return specs.flatMap((spec) => {
      const offsetKm = spanKm * spec.ratio;
      const via = spec.points.map(([along, offset]) => {
        const anchor = sampleRouteAnchor(baseRoute.coordinates ?? [], along);
        if (!anchor) return null;
        return buildAnchoredDetourPoint(anchor.anchor, anchor.tangentStart, anchor.tangentEnd, offsetKm * offset);
      });
      return via.some((point) => point == null)
        ? []
        : [{ label: spec.label, via: via as Point[] }];
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
        const anchor = sampleRouteAnchor(baseRoute.coordinates ?? [], along);
        if (!anchor) return null;
        return buildAnchoredDetourPoint(anchor.anchor, anchor.tangentStart, anchor.tangentEnd, offsetKm * offset);
      });
      return via.some((point) => point == null)
        ? []
        : [{ label: `${pattern.label}-r${ratioIndex + 1}`, via: via as Point[] }];
    });
  });
}

async function uploadProfile(brf: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${UPSTREAM}/brouter/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      body: brf,
    });
  } catch (error) {
    throw new Error(`profile upload failed: ${formatError(error)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`upload HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { profileid?: string; error?: string };
  if (json.error) throw new Error(`profile compile error: ${json.error}`);
  if (!json.profileid) throw new Error(`no profileid in response: ${text}`);
  return json.profileid;
}

async function fetchRoute(
  profile: string,
  from: Point,
  to: Point,
  via: Point[] = [],
  alternativeIdx = 0,
): Promise<RouteStats> {
  const segs = [from, ...via, to]
    .map((p) => `${p.lon},${p.lat}`)
    .join('|');
  const url = `${UPSTREAM}/brouter?lonlats=${segs}&profile=${profile}&format=geojson&alternativeidx=${alternativeIdx}`;
  let lastFailure: RouteStats | null = null;
  for (let attempt = 0; attempt <= WATCHDOG_RETRY_DELAYS_MS.length; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (error) {
      return {
        distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
        status: -1, profileId: profile, error: `route fetch failed: ${formatError(error)}`,
      };
    }
    const text = await res.text();
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || !ct.includes('json') || text.trimStart().toLowerCase().startsWith('error')) {
      lastFailure = {
        distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
        status: res.status, profileId: profile, error: text.slice(0, 200),
      };
      if (lastFailure.error && isWatchdogMessage(lastFailure.error) && attempt < WATCHDOG_RETRY_DELAYS_MS.length) {
        await delay(WATCHDOG_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return lastFailure;
    }
    const fc = JSON.parse(text);
    const props = fc.features?.[0]?.properties ?? {};
    const dist = Number(props['track-length']) || 0;
    const time = Number(props['total-time']) || 0;
    const asc = Number(props['filtered ascend']) || 0;
    const plain = Number(props['plain-ascend']) || 0;
    const directKm = haversineKm(from, to);
    return {
      distanceKm: dist / 1000,
      ascentM: asc,
      descentM: asc - plain,
      durationMin: time / 60,
      tortuosity: directKm > 0 ? (dist / 1000) / directKm : 0,
      status: res.status,
      profileId: profile,
      coordinates: fc.features?.[0]?.geometry?.coordinates as [number, number][] | undefined,
    };
  }
  return lastFailure ?? {
    distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
    status: -1, profileId: profile, error: 'route fetch failed after watchdog retries',
  };
}

interface Scenario {
  name: string;
  priorities?: PrioritiesState;
  roadTypes?: RoadTypesState;
  stockProfile?: string;
  preferClimbEfficiencySearch?: boolean;
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
function plog(msg: string): void {
  console.log(`    [${ts()}] ${msg}`);
  if ((process.stdout as { _flush?: () => void })._flush) (process.stdout as { _flush?: () => void })._flush?.();
}

function wantsGroup(key: string): boolean {
  return ONLY_GROUPS.size === 0 || ONLY_GROUPS.has(key.toUpperCase());
}

/**
 * Best-of-N alternative routing — EE3D recipe. Run BRouter with
 * alternativeidx 0..N-1 in parallel, keep whichever climbs the most.
 */
async function fetchRouteBestOfN(
  profile: string,
  from: Point,
  to: Point,
  via: Point[] = [],
  n = 4,
  scoreRoute: (route: RouteStats) => number = (route) => route.ascentM,
  label = 'max ascent',
): Promise<RouteStats> {
  plog(`best-of-N start  n=${n}  mode=${label}  profile=${profile}`);
  const t0 = Date.now();
  const attempts = Array.from({ length: n }, (_, i) =>
    fetchRouteAlt(profile, from, to, via, i),
  );
  const results = await Promise.all(attempts);
  let best: RouteStats | null = null;
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.error) continue;
    const score = scoreRoute(r);
    if (Number.isFinite(score) && score > bestScore) {
      best = r;
      bestIdx = i;
      bestScore = score;
    }
  }
  const ascList = results.map((r) => (r.error ? 'fail' : `${Math.round(r.ascentM)}m`)).join(', ');
  const distList = results.map((r) => (r.error ? 'fail' : `${r.distanceKm.toFixed(1)}km`)).join(', ');
  plog(`best-of-N done in ${Date.now() - t0}ms  d+=[${ascList}]  dist=[${distList}]  picked idx=${bestIdx} score=${bestScore.toFixed(1)}`);
  if (!best) {
    return {
      distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
      status: -1, profileId: profile,
      error: results[0]?.error ?? 'all alternatives failed',
    };
  }
  return best;
}

async function fetchRouteBestWithDistanceDetours(
  profile: string,
  from: Point,
  to: Point,
  scoreRoute: (route: RouteStats) => number,
  label: string,
  distanceFocus: number,
  climbFocus: number,
): Promise<RouteStats> {
  plog(`detour search start mode=${label} profile=${profile}`);
  let best: RouteStats | null = null;
  let baseRoute: RouteStats | null = null;
  let bestLabel = '';
  let bestScore = -Infinity;
  let lastError: Error | null = null;

  const consider = (route: RouteStats, candidateLabel: string) => {
    const score = scoreRoute(route);
    plog(`detour ${candidateLabel} OK score=${score.toFixed(1)} dist=${route.distanceKm.toFixed(1)}km d+=${Math.round(route.ascentM)}m`);
    if (Number.isFinite(score) && score > bestScore) {
      best = route;
      bestLabel = candidateLabel;
      bestScore = score;
    }
  };

  const alternatives = await fetchRouteBestOfN(profile, from, to, [], 4, scoreRoute, label);
  if (alternatives.error) {
    lastError = new Error(alternatives.error);
    plog(`detour alternatives failed: ${alternatives.error.slice(0, 120)}`);
    const fallbackRoute = await fetchRoute(profile, from, to);
    if (fallbackRoute.error) {
      lastError = new Error(fallbackRoute.error);
      plog(`detour direct fallback failed: ${fallbackRoute.error.slice(0, 120)}`);
    } else {
      baseRoute = fallbackRoute;
      consider(fallbackRoute, 'direct-fallback');
    }
  } else {
    baseRoute = alternatives;
    consider(alternatives, 'alternatives');
  }

  for (const candidate of buildDistanceDetourCandidates(from, to, distanceFocus, climbFocus, baseRoute)) {
    const route = await fetchRoute(profile, from, to, candidate.via, 0);
    if (route.error) {
      lastError = new Error(route.error);
      if (!isExpectedDetourCandidateFailure(route.error)) {
        plog(`detour ${candidate.label} failed: ${route.error.slice(0, 120)}`);
      }
      continue;
    }
    consider(route, candidate.label);
  }
  if (!best) {
    return {
      distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
      status: -1, profileId: profile, error: lastError?.message ?? 'all detours failed',
    };
  }
  plog(`detour search picked ${bestLabel} score=${bestScore.toFixed(1)}`);
  return best;
}

async function fetchRouteBestWithClimbEfficiencyDetours(
  profile: string,
  from: Point,
  to: Point,
): Promise<RouteStats> {
  plog(`climb-efficiency focused search start profile=${profile}`);
  let best: RouteStats | null = null;
  let baseline: RouteStats | null = null;
  let bestLabel = '';
  let bestScore = -Infinity;
  let lastError: Error | null = null;

  const consider = (route: RouteStats, candidateLabel: string) => {
    if (!baseline) return;
    const score = scoreMinDistanceMaxAscent(route, baseline);
    const efficiency = computeClimbEfficiency(route, baseline);
    plog(
      `climb-efficiency ${candidateLabel} score=${score.toFixed(1)} ` +
      `deltaKm=${efficiency.addedDistanceKm.toFixed(1)} deltaD+=${Math.round(efficiency.addedAscentM)} ` +
      `gain/km=${efficiency.gainPerAddedKm.toFixed(1)}`,
    );
    if (Number.isFinite(score) && score > bestScore) {
      best = route;
      bestLabel = candidateLabel;
      bestScore = score;
    }
  };

  const directBase = await fetchRoute(profile, from, to, [], 0);
  if (directBase.error) {
    lastError = new Error(directBase.error);
    return {
      distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
      status: -1, profileId: profile, error: directBase.error,
    };
  }
  baseline = directBase;
  consider(directBase, 'direct-alt-0');

  for (const candidate of buildClimbEfficiencyDetourCandidates(from, to, baseline)) {
    for (const alternativeIdx of candidate.alternativeIdxs) {
      const route = await fetchRoute(profile, from, to, candidate.via, alternativeIdx);
      if (route.error) {
        lastError = new Error(route.error);
        if (!isExpectedDetourCandidateFailure(route.error)) {
          plog(`climb-efficiency ${candidate.label} alt=${alternativeIdx} failed: ${route.error.slice(0, 120)}`);
        }
        continue;
      }
      consider(route, `${candidate.label}-alt${alternativeIdx}`);
    }
  }

  if (!best) {
    return {
      distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
      status: -1, profileId: profile, error: lastError?.message ?? 'all climb-efficiency candidates failed',
    };
  }
  plog(`climb-efficiency picked ${bestLabel} score=${bestScore.toFixed(1)}`);
  return best;
}

async function fetchRouteAlt(
  profile: string,
  from: Point,
  to: Point,
  via: Point[],
  alt: number,
): Promise<RouteStats> {
  return fetchRoute(profile, from, to, via, alt);
}

async function runScenario(s: Scenario, route: BenchRoute = DEFAULT_ROUTE): Promise<RouteStats> {
  if (s.stockProfile) return fetchRoute(s.stockProfile, route.from, route.to);
  const priorities = s.priorities ?? NEUTRAL_PRIORITIES;
  const brf = buildBrfProfile({
    priorities,
    roadTypes: s.roadTypes ?? rt(),
    expert: null,
  });
  const profileId = await uploadProfile(brf);
  if (s.preferClimbEfficiencySearch) {
    return fetchRouteBestWithClimbEfficiencyDetours(profileId, route.from, route.to);
  }
  const distanceFocus = Math.max(0, ((priorities.distance - 50) / 50));
  const distanceAvoid = Math.max(0, ((50 - priorities.distance) / 50));
  const climbFocus = Math.max(0, ((priorities.elevation - 50) / 50));
  const durationFocus = Math.max(0, ((priorities.duration - 50) / 50));
  if (distanceAvoid > 0.65) {
    return fetchRouteBestOfN(
      profileId,
      route.from,
      route.to,
      [],
      4,
      (route) => -(((route.distanceKm * 1000) * 1.4) + (route.durationMin * 60 * 18)),
      'min distance + directness',
    );
  }
  if (isClimbingMode(priorities) && distanceFocus > 0.5) {
    return fetchRouteBestWithDistanceDetours(
      profileId,
      route.from,
      route.to,
      scoreMaxAscentLongDistance,
      'max ascent + long distance',
      distanceFocus,
      climbFocus,
    );
  }
  if (isClimbingMode(priorities)) {
    return fetchRouteBestOfN(profileId, route.from, route.to, [], 4);
  }
  if (distanceFocus > 0.65) {
    return fetchRouteBestWithDistanceDetours(
      profileId,
      route.from,
      route.to,
      (route) => route.distanceKm,
      'max distance',
      distanceFocus,
      climbFocus,
    );
  }
  if (durationFocus > 0.65) {
    return fetchRouteBestOfN(
      profileId,
      route.from,
      route.to,
      [],
      4,
      (route) => -((route.durationMin * 60 * 35) + (route.distanceKm * 1000)),
      'min duration + directness',
    );
  }
  return fetchRoute(profileId, route.from, route.to);
}

function fmtRow(name: string, r: RouteStats, widthName: number): string {
  const errSuffix = r.error ? `  ❌ ${r.error}` : '';
  return [
    name.padEnd(widthName),
    r.profileId.padEnd(22),
    r.distanceKm.toFixed(1).padStart(7),
    String(Math.round(r.ascentM)).padStart(7),
    String(Math.round(r.descentM)).padStart(7),
    r.durationMin.toFixed(0).padStart(7),
    String(r.status).padStart(4),
    errSuffix,
  ].join('  ');
}

function header(label: string, widthName: number): void {
  console.log(`\n══ ${label} ${'═'.repeat(Math.max(0, 110 - label.length))}`);
  console.log(
    [
      'scenario'.padEnd(widthName),
      'profileid'.padEnd(22),
      'dist(km)'.padStart(7),
      'asc(m)'.padStart(7),
      'desc(m)'.padStart(7),
      'dur(min)'.padStart(7),
      'stat'.padStart(4),
    ].join('  '),
  );
  console.log('─'.repeat(widthName + 70));
}

interface RunResult {
  scenario: Scenario;
  stats: RouteStats;
}

async function runGroup(label: string, scenarios: Scenario[], route: BenchRoute = DEFAULT_ROUTE): Promise<RunResult[]> {
  const widthName = Math.max(20, ...scenarios.map((s) => s.name.length));
  header(label, widthName);
  console.log(`Route            : ${route.label}`);
  console.log(`                   ${route.from.lat},${route.from.lon} → ${route.to.lat},${route.to.lon}`);
  const out: RunResult[] = [];
  for (const s of scenarios) {
    try {
      const r = await runScenario(s, route);
      console.log(fmtRow(s.name, r, widthName));
      out.push({ scenario: s, stats: r });
    } catch (e) {
      const stats: RouteStats = {
        distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
        status: -1, profileId: '-', error: (e as Error).message,
      };
      console.log(`${s.name.padEnd(widthName)}  ❌ ${(e as Error).message}`);
      out.push({ scenario: s, stats });
    }
  }
  return out;
}

type Metric = keyof Pick<RouteStats, 'distanceKm' | 'ascentM' | 'descentM' | 'durationMin' | 'tortuosity'>;
const METRIC_LABEL: Record<Metric, string> = {
  distanceKm: 'dist (km)',
  ascentM: 'd+ (m)',
  descentM: 'd- (m)',
  durationMin: 'dur (min)',
  tortuosity: 'tortuosity',
};

function fmtMetricValue(metric: Metric, value: number): string {
  return metric === 'tortuosity' ? value.toFixed(3) : value.toFixed(0);
}

interface AbsCheck {
  kind: 'abs';
  index: number;
  metric: Metric;
  cmp: '>=' | '<=';
  value: number;
}
interface DeltaCheck {
  kind: 'delta';
  low: number;
  high: number;
  metric: Metric;
  cmp: '>=' | '<=';
  value: number;
}
interface RatioCheck {
  kind: 'ratio';
  low: number;
  high: number;
  metric: Metric;
  ratio: number;
}
interface EfficiencyCheck {
  kind: 'efficiency';
  baseline: number;
  scenario: number;
  minGainPerAddedKm: number;
  minAddedAscentM?: number;
  maxAddedDistanceKm?: number;
}
type Check = AbsCheck | DeltaCheck | RatioCheck | EfficiencyCheck;

let totalChecks = 0;
let failedChecks = 0;

function runChecks(label: string, results: RunResult[], checks: Check[]): void {
  console.log(`\n  Sanity checks for «${label}»:`);
  for (const c of checks) {
    totalChecks++;
    if (c.kind === 'abs') {
      const r = results[c.index];
      if (r.stats.error) {
        failedChecks++;
        console.log(`    ⚠ ${r.scenario.name} — route failed (${r.stats.error})`);
        continue;
      }
      const v = r.stats[c.metric] as number;
      const ok = c.cmp === '>=' ? v >= c.value : v <= c.value;
      if (!ok) failedChecks++;
      console.log(
        `    ${ok ? '✅' : '❌'} ${r.scenario.name}: ${METRIC_LABEL[c.metric]}=${fmtMetricValue(c.metric, v)} ${c.cmp} ${c.value}`,
      );
    } else if (c.kind === 'delta') {
      const lo = results[c.low];
      const hi = results[c.high];
      if (lo.stats.error || hi.stats.error) {
        failedChecks++;
        console.log(`    ⚠ skipping ${lo.scenario.name} ↔ ${hi.scenario.name}`);
        continue;
      }
      const dv = (hi.stats[c.metric] as number) - (lo.stats[c.metric] as number);
      const ok = c.cmp === '>=' ? dv >= c.value : dv <= c.value;
      if (!ok) failedChecks++;
      const arrow = dv > 0 ? '↑' : dv < 0 ? '↓' : '=';
      console.log(
        `    ${ok ? '✅' : '❌'} Δ${METRIC_LABEL[c.metric]} ${arrow} ${fmtMetricValue(c.metric, dv)} ` +
          `(${lo.scenario.name} → ${hi.scenario.name}, expect ${c.cmp} ${c.value})`,
      );
    } else if (c.kind === 'ratio') {
      const lo = results[c.low];
      const hi = results[c.high];
      if (lo.stats.error || hi.stats.error) {
        failedChecks++;
        console.log(`    ⚠ skipping ${lo.scenario.name} ↔ ${hi.scenario.name}`);
        continue;
      }
      const lov = lo.stats[c.metric] as number;
      const hiv = hi.stats[c.metric] as number;
      const ratio = lov > 0 ? hiv / lov : Infinity;
      const ok = ratio >= c.ratio;
      if (!ok) failedChecks++;
      console.log(
        `    ${ok ? '✅' : '❌'} ${METRIC_LABEL[c.metric]} ratio = ${fmtMetricValue(c.metric, hiv)}/${fmtMetricValue(c.metric, lov)} = ${ratio.toFixed(2)}× ` +
          `(${lo.scenario.name} → ${hi.scenario.name}, expect ≥ ${c.ratio}×)`,
      );
    } else {
      const baseline = results[c.baseline];
      const scenario = results[c.scenario];
      if (baseline.stats.error || scenario.stats.error) {
        failedChecks++;
        console.log(`    ⚠ skipping ${baseline.scenario.name} ↔ ${scenario.scenario.name}`);
        continue;
      }
      const efficiency = computeClimbEfficiency(scenario.stats, baseline.stats);
      const okGainPerKm = efficiency.gainPerAddedKm >= c.minGainPerAddedKm;
      const okAddedAscent = c.minAddedAscentM === undefined || efficiency.addedAscentM >= c.minAddedAscentM;
      const okAddedDistance = c.maxAddedDistanceKm === undefined || efficiency.addedDistanceKm <= c.maxAddedDistanceKm;
      const ok = okGainPerKm && okAddedAscent && okAddedDistance;
      if (!ok) failedChecks++;
      console.log(
        `    ${ok ? '✅' : '❌'} climb efficiency = ${efficiency.addedAscentM.toFixed(0)}m / ${efficiency.addedDistanceKm.toFixed(1)}km = ${efficiency.gainPerAddedKm.toFixed(1)} m/km ` +
          `(${baseline.scenario.name} → ${scenario.scenario.name}, expect gain/km ≥ ${c.minGainPerAddedKm}` +
          `${c.minAddedAscentM === undefined ? '' : `, Δd+ ≥ ${c.minAddedAscentM}`}` +
          `${c.maxAddedDistanceKm === undefined ? '' : `, Δdist ≤ ${c.maxAddedDistanceKm}`}` +
          `)`,
      );
    }
  }
}

const BASELINE_SCENARIOS: Scenario[] = [
  { name: '0a stock trekking',         stockProfile: 'trekking' },
  { name: '0b default (all neutral)' },
];

const ELEV_SCENARIOS: Scenario[] = [
  { name: 'E0  elevation=0   max-flat',   priorities: pri({ elevation: 0 }) },
  { name: 'E1  elevation=25  avoid hills',priorities: pri({ elevation: 25 }) },
  { name: 'E2  elevation=50  neutral',    priorities: pri({ elevation: 50 }) },
  { name: 'E3  elevation=75  seek hills', priorities: pri({ elevation: 75 }) },
  { name: 'E4  elevation=100 max-hilly',  priorities: pri({ elevation: 100 }) },
];

const DIST_SCENARIOS: Scenario[] = [
  { name: 'D0  distance=0    shortest',   priorities: pri({ distance: 0 }) },
  { name: 'D1  distance=50   neutral',    priorities: pri({ distance: 50 }) },
  { name: 'D2  distance=100  scenic',     priorities: pri({ distance: 100 }) },
];

const MAX_DISTANCE_CLIMB_SCENARIOS: Scenario[] = [
  { name: 'X0  neutral baseline',              priorities: pri() },
  {
    name: 'X1  distance=0 elevation=100  smart climb',
    priorities: pri({ distance: 0, elevation: 100 }),
    preferClimbEfficiencySearch: true,
  },
  { name: 'X2  distance=100 elevation=100',    priorities: pri({ distance: 100, elevation: 100 }) },
];

const DUR_SCENARIOS: Scenario[] = [
  { name: 'T0  duree=0   no rush',         priorities: pri({ duration: 0 }) },
  { name: 'T1  duree=50  neutral',         priorities: pri({ duration: 50 }) },
  { name: 'T2  duree=100 fast / direct',   priorities: pri({ duration: 100 }) },
];

const TRANQ_SCENARIOS: Scenario[] = [
  { name: 'Q0  tranq=0   traffic OK',     priorities: pri({ tranquility: 0 }) },
  { name: 'Q1  tranq=50  neutral',        priorities: pri({ tranquility: 50 }) },
  { name: 'Q2  tranq=100 max quiet',      priorities: pri({ tranquility: 100 }) },
];

const SLOPE_SCENARIOS: Scenario[] = [
  { name: 'S0 maxSlope=99 (off)',         roadTypes: rt({ maxSlopePercent: 99 }) },
  { name: 'S1 maxSlope=15',               roadTypes: rt({ maxSlopePercent: 15 }) },
  { name: 'S2 maxSlope=8',                roadTypes: rt({ maxSlopePercent: 8 }) },
  { name: 'S3 maxSlope=4',                roadTypes: rt({ maxSlopePercent: 4 }) },
];

const ROADTYPE_SCENARIOS: Scenario[] = [
  { name: 'R0 default (all tolerate)' },
  { name: 'R1 forbid singletrack',                roadTypes: rt({ singletrack: 'forbid' }) },
  { name: 'R2 forbid offroad',                    roadTypes: rt({ offroad: 'forbid' }) },
  { name: 'R3 forbid majorRoads',                 roadTypes: rt({ majorRoads: 'forbid' }) },
  { name: 'R4 forbid road, prefer gravel',        roadTypes: rt({ road: 'forbid', gravel: 'prefer' }) },
  { name: 'R5 prefer road, forbid gravel/sing.',  roadTypes: rt({ road: 'prefer', gravel: 'forbid', singletrack: 'forbid', offroad: 'forbid' }) },
  { name: 'R6 prefer bikeLanes',                  roadTypes: rt({ bikeLanes: 'prefer' }) },
  { name: 'R7 forbid ferries',                    roadTypes: rt({ ferry: 'forbid' }) },
];

const TURNS_SCENARIOS: Scenario[] = [
  { name: 'V0 turns prefer',     roadTypes: rt({ turns: 'prefer' }) },
  { name: 'V1 turns tolerate',   roadTypes: rt({ turns: 'tolerate' }) },
  { name: 'V2 turns avoid',      roadTypes: rt({ turns: 'avoid' }) },
  { name: 'V3 turns forbid',     roadTypes: rt({ turns: 'forbid' }) },
];

const CITIES_SCENARIOS: Scenario[] = [
  { name: 'C0 cities tolerate',  roadTypes: rt({ cities: 'tolerate' }) },
  { name: 'C1 cities avoid',     roadTypes: rt({ cities: 'avoid' }) },
  { name: 'C2 cities forbid',    roadTypes: rt({ cities: 'forbid' }) },
];

(async () => {
  console.log(`BRouter upstream : ${UPSTREAM}`);
  console.log(`Default route    : ${DEFAULT_ROUTE.label}`);
  console.log(`                   ${DEFAULT_ROUTE.from.lat},${DEFAULT_ROUTE.from.lon} → ${DEFAULT_ROUTE.to.lat},${DEFAULT_ROUTE.to.lon}\n`);

  const baseline = wantsGroup('B') ? await runGroup('Baseline (sanity)', BASELINE_SCENARIOS, DEFAULT_ROUTE) : [];

  if (wantsGroup('E')) {
    const elev = await runGroup('Group E — Dénivelé slider (climbing mode best-of-N above 70)', ELEV_SCENARIOS, DEFAULT_ROUTE);
    runChecks('Élévation', elev, [
      { kind: 'delta', low: 2, high: 3, metric: 'ascentM',  cmp: '>=', value: 200 },
      { kind: 'delta', low: 2, high: 4, metric: 'ascentM',  cmp: '>=', value: 500 },
      { kind: 'delta', low: 2, high: 0, metric: 'ascentM',  cmp: '<=', value: -100 },
      { kind: 'abs', index: 4, metric: 'ascentM', cmp: '>=', value: 1700 },
    ]);
  }

  if (wantsGroup('D')) {
    const dist = await runGroup('Group D — Distance slider', DIST_SCENARIOS, DEFAULT_ROUTE);
    runChecks('Distance', dist, [
      { kind: 'abs', index: 0, metric: 'distanceKm', cmp: '<=', value: 165 },
      { kind: 'ratio', low: 0, high: 2, metric: 'distanceKm', ratio: 1.5 },
    ]);
  }

  if (wantsGroup('X')) {
    const maxClimbAlps = await runGroup('Group X — Min/Max distance + max D+ (Alps)', MAX_DISTANCE_CLIMB_SCENARIOS, DEFAULT_ROUTE);
    runChecks('Min/Max distance + D+ / Alps', maxClimbAlps, [
      { kind: 'efficiency', baseline: 0, scenario: 1, minGainPerAddedKm: 180, minAddedAscentM: 1800, maxAddedDistanceKm: 18 },
      { kind: 'abs', index: 2, metric: 'ascentM', cmp: '>=', value: 10000 },
      { kind: 'delta', low: 0, high: 2, metric: 'ascentM', cmp: '>=', value: 9000 },
    ]);
    const maxClimbMorvan = await runGroup('Group X — Min/Max distance + max D+ (Morvan)', MAX_DISTANCE_CLIMB_SCENARIOS, MORVAN_ROUTE);
    runChecks('Min/Max distance + D+ / Morvan', maxClimbMorvan, [
      { kind: 'efficiency', baseline: 0, scenario: 1, minGainPerAddedKm: 35, minAddedAscentM: 250, maxAddedDistanceKm: 20 },
      { kind: 'delta', low: 0, high: 2, metric: 'ascentM', cmp: '>=', value: 400 },
    ]);
  }

  if (wantsGroup('T')) {
    const dur = await runGroup('Group T — Durée slider', DUR_SCENARIOS, DEFAULT_ROUTE);
    runChecks('Durée', dur, [
      { kind: 'delta', low: 0, high: 2, metric: 'durationMin', cmp: '<=', value: -5 },
      { kind: 'delta', low: 0, high: 2, metric: 'distanceKm', cmp: '<=', value: -3 },
      { kind: 'delta', low: 0, high: 2, metric: 'tortuosity', cmp: '<=', value: -0.02 },
    ]);
  }

  if (wantsGroup('Q')) {
    const tranq = await runGroup('Group Q — Tranquilité slider', TRANQ_SCENARIOS, DEFAULT_ROUTE);
    runChecks('Tranquilité', tranq, [
      { kind: 'delta', low: 0, high: 2, metric: 'distanceKm', cmp: '>=', value: 3 },
    ]);
  }

  if (wantsGroup('S')) {
    const slope = await runGroup('Group S — Max slope cap', SLOPE_SCENARIOS, DEFAULT_ROUTE);
    runChecks('Max slope', slope, [
      { kind: 'delta', low: 0, high: 3, metric: 'distanceKm', cmp: '>=', value: 5 },
    ]);
  }

  if (wantsGroup('R')) {
    const road = await runGroup('Group R — Road type filters', ROADTYPE_SCENARIOS, DEFAULT_ROUTE);
    runChecks('Road types', road, [
      { kind: 'delta', low: 0, high: 3, metric: 'distanceKm', cmp: '>=', value: 0 },
    ]);
  }

  if (wantsGroup('V')) {
    const turns = await runGroup('Group V — Turns preference', TURNS_SCENARIOS, DEFAULT_ROUTE);
    runChecks('Turns', turns, [
      { kind: 'delta', low: 0, high: 3, metric: 'distanceKm', cmp: '>=', value: 0 },
    ]);
  }

  if (wantsGroup('C')) {
    const cities = await runGroup('Group C — Cities filter', CITIES_SCENARIOS, DEFAULT_ROUTE);
    runChecks('Cities', cities, [
      { kind: 'delta', low: 0, high: 2, metric: 'distanceKm', cmp: '>=', value: 0 },
    ]);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(`Total checks : ${totalChecks}`);
  console.log(`Passed       : ${totalChecks - failedChecks}`);
  console.log(`Failed       : ${failedChecks}`);
  console.log(baseline.length ? '' : '');
  if (failedChecks > 0) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
