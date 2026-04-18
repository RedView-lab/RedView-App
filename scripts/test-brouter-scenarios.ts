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

const UPSTREAM =
  process.env.BROUTER_UPSTREAM?.replace(/\/+$/, '') ?? 'http://135.116.81.157';

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
  status: number;
  profileId: string;
  error?: string;
}

async function uploadProfile(brf: string): Promise<string> {
  const res = await fetch(`${UPSTREAM}/brouter/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    body: brf,
  });
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
  const res = await fetch(url);
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok || !ct.includes('json') || text.trimStart().toLowerCase().startsWith('error')) {
    return {
      distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0,
      status: res.status, profileId: profile, error: text.slice(0, 200),
    };
  }
  const fc = JSON.parse(text);
  const props = fc.features?.[0]?.properties ?? {};
  const dist = Number(props['track-length']) || 0;
  const time = Number(props['total-time']) || 0;
  const asc = Number(props['filtered ascend']) || 0;
  const plain = Number(props['plain-ascend']) || 0;
  return {
    distanceKm: dist / 1000,
    ascentM: asc,
    descentM: asc - plain,
    durationMin: time / 60,
    status: res.status,
    profileId: profile,
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
): Promise<RouteStats> {
  plog(`best-of-N start  n=${n}  profile=${profile}`);
  const t0 = Date.now();
  const attempts = Array.from({ length: n }, (_, i) =>
    fetchRouteAlt(profile, from, to, via, i),
  );
  const results = await Promise.all(attempts);
  let best: RouteStats | null = null;
  let bestIdx = -1;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.error) continue;
    if (!best || r.ascentM > best.ascentM) {
      best = r;
      bestIdx = i;
    }
  }
  const ascList = results.map((r) => (r.error ? 'fail' : `${Math.round(r.ascentM)}m`)).join(', ');
  plog(`best-of-N done in ${Date.now() - t0}ms  d+=[${ascList}]  picked idx=${bestIdx}`);
  if (!best) {
    return {
      distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0,
      status: -1, profileId: profile,
      error: results[0]?.error ?? 'all alternatives failed',
    };
  }
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
  // Climbing mode: fan out best-of-N alternatives, pick the steepest.
  if (isClimbingMode(priorities)) {
    return fetchRouteBestOfN(profileId, ROUTE.from, ROUTE.to, [], 4);
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
        distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0,
        status: -1, profileId: '-', error: (e as Error).message,
      };
      console.log(`${s.name.padEnd(widthName)}  ❌ ${(e as Error).message}`);
      out.push({ scenario: s, stats });
    }
  }
  return out;
}

type Metric = keyof Pick<RouteStats, 'distanceKm' | 'ascentM' | 'descentM' | 'durationMin'>;
const METRIC_LABEL: Record<Metric, string> = {
  distanceKm: 'dist (km)',
  ascentM: 'd+ (m)',
  descentM: 'd- (m)',
  durationMin: 'dur (min)',
};

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
        `    ${ok ? '✅' : '❌'} ${r.scenario.name}: ${METRIC_LABEL[c.metric]}=${v.toFixed(0)} ${c.cmp} ${c.value}`,
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
        `    ${ok ? '✅' : '❌'} Δ${METRIC_LABEL[c.metric]} ${arrow} ${dv.toFixed(0)} ` +
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
        `    ${ok ? '✅' : '❌'} ${METRIC_LABEL[c.metric]} ratio = ${hiv.toFixed(0)}/${lov.toFixed(0)} = ${ratio.toFixed(2)}× ` +
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

  const baseline = await runGroup('Baseline (sanity)', BASELINE_SCENARIOS);

  const elev = await runGroup('Group E — Dénivelé slider (climbing mode best-of-N above 70)', ELEV_SCENARIOS);
  runChecks('Élévation', elev, [
    // With climbing mode on (E3, E4), d+ MUST jump above the neutral baseline.
    { kind: 'delta', low: 2, high: 3, metric: 'ascentM',  cmp: '>=', value: 200 },
    { kind: 'delta', low: 2, high: 4, metric: 'ascentM',  cmp: '>=', value: 500 },
    // Min slider should stay below baseline d+.
    { kind: 'delta', low: 2, high: 0, metric: 'ascentM',  cmp: '<=', value: -100 },
    // Absolute target: max-hilly on Chamonix→Grenoble should be > 1700m d+.
    { kind: 'abs', index: 4, metric: 'ascentM', cmp: '>=', value: 1700 },
  ]);

  const dist = await runGroup('Group D — Distance slider', DIST_SCENARIOS);
  runChecks('Distance', dist, [
    { kind: 'delta', low: 0, high: 2, metric: 'distanceKm', cmp: '>=', value: 5 },
  ]);

  const dur = await runGroup('Group T — Durée slider', DUR_SCENARIOS);
  runChecks('Durée', dur, [
    // Fast mode should not be drastically slower than no-rush mode.
    // (BRouter computes time separately from cost, so we cannot directly
    // optimize for time — we only steer the route via cost weights.)
    { kind: 'delta', low: 0, high: 2, metric: 'durationMin', cmp: '<=', value: 30 },
  ]);

  const tranq = await runGroup('Group Q — Tranquilité slider', TRANQ_SCENARIOS);
  runChecks('Tranquilité', tranq, [
    { kind: 'delta', low: 0, high: 2, metric: 'distanceKm', cmp: '>=', value: 3 },
  ]);

  const slope = await runGroup('Group S — Max slope cap', SLOPE_SCENARIOS);
  runChecks('Max slope', slope, [
    { kind: 'delta', low: 0, high: 3, metric: 'distanceKm', cmp: '>=', value: 5 },
  ]);

  const road = await runGroup('Group R — Road type filters', ROADTYPE_SCENARIOS);
  runChecks('Road types', road, [
    { kind: 'delta', low: 0, high: 3, metric: 'distanceKm', cmp: '>=', value: 0 },
  ]);

  const turns = await runGroup('Group V — Turns preference', TURNS_SCENARIOS);
  runChecks('Turns', turns, [
    { kind: 'delta', low: 0, high: 3, metric: 'distanceKm', cmp: '>=', value: 0 },
  ]);

  const cities = await runGroup('Group C — Cities filter', CITIES_SCENARIOS);
  runChecks('Cities', cities, [
    { kind: 'delta', low: 0, high: 2, metric: 'distanceKm', cmp: '>=', value: 0 },
  ]);

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
