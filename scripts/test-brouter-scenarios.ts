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
const ONLY_GROUPS = new Set(
  (process.env.BROUTER_BENCH_GROUPS ?? '')
    .split(',')
    .map((group: string) => group.trim().toUpperCase())
    .filter(Boolean),
);

const PT = {
  chamonix: { lat: 45.9237, lon: 6.8694 },
  grenoble: { lat: 45.1885, lon: 5.7245 },
} as const;

const ROUTE = { from: PT.chamonix, to: PT.grenoble, label: 'Chamonix → Grenoble (Alps)' };

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

function isExpectedDetourCandidateFailure(message: string): boolean {
  return /via\d+-position not mapped|error re-tracking track/i.test(message);
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
  const ultraWideRatio = !isDistanceOnly && focusSum >= 1.35
    ? 0.16 + (distanceFocus * 0.08) + (climbFocus * 0.1)
    : Number.NaN;
  const detourRatios = isDistanceOnly
    ? normalizeDetourRatios([
        0.035 + (distanceFocus * 0.015),
        0.055 + (distanceFocus * 0.03),
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
    return {
      distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
      status: res.status, profileId: profile, error: text.slice(0, 200),
    };
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

interface Scenario {
  name: string;
  priorities?: PrioritiesState;
  roadTypes?: RoadTypesState;
  stockProfile?: string;
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

async function fetchRouteAlt(
  profile: string,
  from: Point,
  to: Point,
  via: Point[],
  alt: number,
): Promise<RouteStats> {
  return fetchRoute(profile, from, to, via, alt);
}

async function runScenario(s: Scenario): Promise<RouteStats> {
  if (s.stockProfile) return fetchRoute(s.stockProfile, ROUTE.from, ROUTE.to);
  const priorities = s.priorities ?? NEUTRAL_PRIORITIES;
  const brf = buildBrfProfile({
    priorities,
    roadTypes: s.roadTypes ?? rt(),
    expert: null,
  });
  const profileId = await uploadProfile(brf);
  const distanceFocus = Math.max(0, ((priorities.distance - 50) / 50));
  const distanceAvoid = Math.max(0, ((50 - priorities.distance) / 50));
  const climbFocus = Math.max(0, ((priorities.elevation - 50) / 50));
  const durationFocus = Math.max(0, ((priorities.duration - 50) / 50));
  if (distanceAvoid > 0.65) {
    return fetchRouteBestOfN(
      profileId,
      ROUTE.from,
      ROUTE.to,
      [],
      4,
      (route) => -(((route.distanceKm * 1000) * 1.4) + (route.durationMin * 60 * 18)),
      'min distance + directness',
    );
  }
  if (isClimbingMode(priorities) && distanceFocus > 0.5) {
    return fetchRouteBestWithDistanceDetours(
      profileId,
      ROUTE.from,
      ROUTE.to,
      (route) => (route.ascentM * 1000) + ((route.distanceKm * 1000) * 0.08),
      'max ascent + long distance',
      distanceFocus,
      climbFocus,
    );
  }
  if (isClimbingMode(priorities)) {
    return fetchRouteBestOfN(profileId, ROUTE.from, ROUTE.to, [], 4);
  }
  if (distanceFocus > 0.65) {
    return fetchRouteBestWithDistanceDetours(
      profileId,
      ROUTE.from,
      ROUTE.to,
      (route) => route.distanceKm,
      'max distance',
      distanceFocus,
      climbFocus,
    );
  }
  if (durationFocus > 0.65) {
    return fetchRouteBestOfN(
      profileId,
      ROUTE.from,
      ROUTE.to,
      [],
      4,
      (route) => -((route.durationMin * 60 * 35) + (route.distanceKm * 1000)),
      'min duration + directness',
    );
  }
  return fetchRoute(profileId, ROUTE.from, ROUTE.to);
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

async function runGroup(label: string, scenarios: Scenario[]): Promise<RunResult[]> {
  const widthName = Math.max(20, ...scenarios.map((s) => s.name.length));
  header(label, widthName);
  const out: RunResult[] = [];
  for (const s of scenarios) {
    try {
      const r = await runScenario(s);
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
type Check = AbsCheck | DeltaCheck | RatioCheck;

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
    } else {
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
  { name: 'X1  distance=100 elevation=100',    priorities: pri({ distance: 100, elevation: 100 }) },
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
  console.log(`Route            : ${ROUTE.label}`);
  console.log(`                   ${ROUTE.from.lat},${ROUTE.from.lon} → ${ROUTE.to.lat},${ROUTE.to.lon}\n`);

  const baseline = wantsGroup('B') ? await runGroup('Baseline (sanity)', BASELINE_SCENARIOS) : [];

  if (wantsGroup('E')) {
    const elev = await runGroup('Group E — Dénivelé slider (climbing mode best-of-N above 70)', ELEV_SCENARIOS);
    runChecks('Élévation', elev, [
      { kind: 'delta', low: 2, high: 3, metric: 'ascentM',  cmp: '>=', value: 200 },
      { kind: 'delta', low: 2, high: 4, metric: 'ascentM',  cmp: '>=', value: 500 },
      { kind: 'delta', low: 2, high: 0, metric: 'ascentM',  cmp: '<=', value: -100 },
      { kind: 'abs', index: 4, metric: 'ascentM', cmp: '>=', value: 1700 },
    ]);
  }

  if (wantsGroup('D')) {
    const dist = await runGroup('Group D — Distance slider', DIST_SCENARIOS);
    runChecks('Distance', dist, [
      { kind: 'abs', index: 0, metric: 'distanceKm', cmp: '<=', value: 165 },
      { kind: 'delta', low: 1, high: 2, metric: 'distanceKm', cmp: '>=', value: 40 },
    ]);
  }

  if (wantsGroup('X')) {
    const maxClimb = await runGroup('Group X — Max distance + max D+', MAX_DISTANCE_CLIMB_SCENARIOS);
    runChecks('Max distance + D+', maxClimb, [
      { kind: 'abs', index: 1, metric: 'ascentM', cmp: '>=', value: 10000 },
      { kind: 'delta', low: 0, high: 1, metric: 'ascentM', cmp: '>=', value: 9000 },
    ]);
  }

  if (wantsGroup('T')) {
    const dur = await runGroup('Group T — Durée slider', DUR_SCENARIOS);
    runChecks('Durée', dur, [
      { kind: 'delta', low: 0, high: 2, metric: 'durationMin', cmp: '<=', value: -5 },
      { kind: 'delta', low: 0, high: 2, metric: 'distanceKm', cmp: '<=', value: -3 },
      { kind: 'delta', low: 0, high: 2, metric: 'tortuosity', cmp: '<=', value: -0.02 },
    ]);
  }

  if (wantsGroup('Q')) {
    const tranq = await runGroup('Group Q — Tranquilité slider', TRANQ_SCENARIOS);
    runChecks('Tranquilité', tranq, [
      { kind: 'delta', low: 0, high: 2, metric: 'distanceKm', cmp: '>=', value: 3 },
    ]);
  }

  if (wantsGroup('S')) {
    const slope = await runGroup('Group S — Max slope cap', SLOPE_SCENARIOS);
    runChecks('Max slope', slope, [
      { kind: 'delta', low: 0, high: 3, metric: 'distanceKm', cmp: '>=', value: 5 },
    ]);
  }

  if (wantsGroup('R')) {
    const road = await runGroup('Group R — Road type filters', ROADTYPE_SCENARIOS);
    runChecks('Road types', road, [
      { kind: 'delta', low: 0, high: 3, metric: 'distanceKm', cmp: '>=', value: 0 },
    ]);
  }

  if (wantsGroup('V')) {
    const turns = await runGroup('Group V — Turns preference', TURNS_SCENARIOS);
    runChecks('Turns', turns, [
      { kind: 'delta', low: 0, high: 3, metric: 'distanceKm', cmp: '>=', value: 0 },
    ]);
  }

  if (wantsGroup('C')) {
    const cities = await runGroup('Group C — Cities filter', CITIES_SCENARIOS);
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
