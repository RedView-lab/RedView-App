import {
  buildBrfProfile,
} from '../../src/features/itineraryPanel/lib/brouter/profiles/brf-template';
import { isClimbingMode } from '../../src/features/itineraryPanel/lib/brouter/routing/climb-mode';
import type { PrioritiesState, RoadTypesState } from '../../src/features/itineraryPanel/types';
import { fetchRoute, uploadProfile } from './client';
import {
  type BenchRoute,
  DEFAULT_ROUTE,
  NEUTRAL_PRIORITIES,
  ONLY_GROUPS,
  type Point,
  type RouteStats,
  rt,
} from './config';
import {
  buildClimbEfficiencyDetourCandidates,
  buildDistanceDetourCandidates,
  computeClimbEfficiency,
  isExpectedDetourCandidateFailure,
  scoreMaxAscentLongDistance,
  scoreMinDistanceMaxAscent,
} from './detours';

// Exécution des scénarios (meilleur de N, détours) et affichage des résultats.

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { _flush?: () => void };
  exitCode?: number;
  exit(code?: number): never;
};

export interface Scenario {
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

export function wantsGroup(key: string): boolean {
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

export interface RunResult {
  scenario: Scenario;
  stats: RouteStats;
}

export async function runGroup(label: string, scenarios: Scenario[], route: BenchRoute = DEFAULT_ROUTE): Promise<RunResult[]> {
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
