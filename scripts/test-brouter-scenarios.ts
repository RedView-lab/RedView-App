/**
 * Comprehensive scenario tests for the BRF generator + upload pipeline.
 *
 *   npx tsx scripts/test-brouter-scenarios.ts
 */
import { failedChecks, runChecks, totalChecks } from './brouter-scenarios/checks';
import { DEFAULT_ROUTE, MORVAN_ROUTE, UPSTREAM } from './brouter-scenarios/config';
import { runGroup, wantsGroup } from './brouter-scenarios/runner';
import {
  BASELINE_SCENARIOS,
  CITIES_SCENARIOS,
  DIST_SCENARIOS,
  DUR_SCENARIOS,
  ELEV_SCENARIOS,
  MAX_DISTANCE_CLIMB_SCENARIOS,
  ROADTYPE_SCENARIOS,
  SLOPE_SCENARIOS,
  TRANQ_SCENARIOS,
  TURNS_SCENARIOS,
} from './brouter-scenarios/scenarios';

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { _flush?: () => void };
  exitCode?: number;
  exit(code?: number): never;
};

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
