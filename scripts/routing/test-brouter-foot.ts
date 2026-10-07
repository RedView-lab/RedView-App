/**
 * Pedestrian (Running / Trail) BRF profiles against the BRouter server.
 *
 *   npx tsx scripts/routing/test-brouter-foot.ts
 *   BROUTER_UPSTREAM=http://<vps> npx tsx scripts/routing/test-brouter-foot.ts
 *
 * 1. Every Running / Trail preset × tracing mode compiles on the server
 *    (an unknown lookup name/value in the BRF is a compile error).
 * 2. The stock pedestrian fallback profile exists on the server.
 * 3. Scenario routes land on the expected network (sidewalks & car-free
 *    ways in town, paths in the mountains) and respect the SAC ceiling.
 * 4. Bike presets never emit pedestrian directives.
 */
import { buildBrfProfile } from '../../src/features/itineraryPanel/lib/brouter/profiles/brf-template';
import { FOOT_FALLBACK_PROFILE } from '../../src/features/itineraryPanel/lib/brouter/types';
import {
  syncTracageOnActivityChange,
  type ActivityType,
  type TracingModeType,
} from '../../src/features/itineraryPanel/lib/project/syncTracageParams';
import type {
  PrioritiesState,
  RoadTypesState,
} from '../../src/features/itineraryPanel/types';
import type { SportDiscipline } from '../../src/shared/lib/discipline';

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

const UPSTREAM =
  process.env.BROUTER_UPSTREAM?.replace(/\/+$/, '').replace(/\/brouter$/, '') ?? 'http://localhost:17777';

type Point = { lat: number; lon: number };
const MODES: TracingModeType[] = ['vitesse', 'aventure', 'comfort'];

const SAC_GRADES: Record<string, number> = {
  hiking: 1,
  'T1-hiking': 1,
  yes: 1,
  mountain_hiking: 2,
  demanding_mountain_hiking: 3,
  alpine_hiking: 4,
  demanding_alpine_hiking: 5,
  difficult_alpine_hiking: 6,
};

/** SAC ceilings mirrored from brf-template/values.ts (resolveFootValues). */
function sacLimitFor(activity: 'running' | 'trail', mode: TracingModeType): number {
  if (activity === 'running') return mode === 'aventure' ? 2 : 1;
  return mode === 'comfort' ? 2 : mode === 'aventure' ? 4 : 3;
}

const BASE_ROAD_TYPES: RoadTypesState = {
  road: 'tolerate',
  gravel: 'tolerate',
  singletrack: 'tolerate',
  offroad: 'tolerate',
  bikeLanes: 'tolerate',
  majorRoads: 'tolerate',
  ferry: 'tolerate',
  turns: 'tolerate',
  maxSlopePercent: 99,
  cities: 'tolerate',
  applyToAllItineraries: false,
};

function presetBrf(activity: ActivityType, mode: TracingModeType): string {
  const sync = syncTracageOnActivityChange(activity, mode, 10);
  const discipline: SportDiscipline = activity === 'running' || activity === 'trail' ? activity : 'bike';
  return buildBrfProfile({
    priorities: sync.priorities as PrioritiesState,
    roadTypes: { ...BASE_ROAD_TYPES, ...sync.roadTypes },
    discipline,
  });
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

interface RouteStats {
  distanceKm: number;
  ascentM: number;
  durationMin: number;
  /** Share of distance (0..1) per highway=* value. */
  highwayShare: Record<string, number>;
  /** Highest SAC grade met along the route. */
  maxSac: number;
  /** Share of distance tagged foot=no / access=no without foot override. */
  footForbiddenShare: number;
}

async function fetchRoute(profile: string, points: Point[]): Promise<RouteStats> {
  const lonlats = points.map((p) => `${p.lon},${p.lat}`).join('|');
  const res = await fetch(`${UPSTREAM}/brouter?lonlats=${lonlats}&profile=${profile}&format=geojson`);
  const text = await res.text();
  if (!res.ok || text.trimStart().toLowerCase().startsWith('error') || !text.trimStart().startsWith('{')) {
    throw new Error(`route HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as {
    features: { properties: Record<string, unknown> & { messages: string[][] } }[];
  };
  const props = json.features[0]!.properties;
  const [header, ...rows] = props.messages;
  const distIdx = header!.indexOf('Distance');
  const tagsIdx = header!.indexOf('WayTags');
  const total = Number(props['track-length']);
  const byHighway: Record<string, number> = {};
  let maxSac = 0;
  let forbidden = 0;
  for (const row of rows) {
    const dist = Number(row[distIdx]);
    const tags = row[tagsIdx] ?? '';
    const highway = /(?:^|\s)highway=(\S+)/.exec(tags)?.[1] ?? 'none';
    byHighway[highway] = (byHighway[highway] ?? 0) + dist;
    const sac = /(?:^|\s)sac_scale=(\S+)/.exec(tags)?.[1];
    if (sac) maxSac = Math.max(maxSac, SAC_GRADES[sac] ?? 0);
    if (/(?:^|\s)foot=(no|private)(?:\s|$)/.test(tags)) forbidden += dist;
  }
  const highwayShare: Record<string, number> = {};
  for (const [k, v] of Object.entries(byHighway)) highwayShare[k] = total > 0 ? v / total : 0;
  return {
    distanceKm: total / 1000,
    ascentM: Number(props['filtered ascend']),
    durationMin: Number(props['total-time']) / 60,
    highwayShare,
    maxSac,
    footForbiddenShare: total > 0 ? forbidden / total : 0,
  };
}

function share(stats: RouteStats, highways: string[]): number {
  return highways.reduce((sum, h) => sum + (stats.highwayShare[h] ?? 0), 0);
}

function fmtShares(stats: RouteStats): string {
  return Object.entries(stats.highwayShare)
    .sort((a, b) => b[1] - a[1])
    .filter(([, v]) => v >= 0.01)
    .map(([k, v]) => `${k}:${Math.round(v * 100)}%`)
    .join(' ');
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

const FOOT_WAYS = ['footway', 'pedestrian', 'living_street', 'path', 'steps', 'cycleway'];
const TRAIL_WAYS = ['path', 'track', 'footway', 'bridleway', 'steps'];
const MOTOR_WAYS = ['motorway', 'motorway_link', 'trunk', 'trunk_link'];
const BUSY_WAYS = ['primary', 'primary_link', 'secondary', 'secondary_link'];

interface Scenario {
  label: string;
  activity: 'running' | 'trail';
  points: Point[];
  assert: (stats: RouteStats, mode: TracingModeType) => void;
}

const SCENARIOS: Scenario[] = [
  {
    label: 'Paris République → Bastille (running)',
    activity: 'running',
    points: [{ lat: 48.8674, lon: 2.3634 }, { lat: 48.8531, lon: 2.3692 }],
    assert: (s, mode) => {
      // Aventure trades sidewalks for scenic quays (river relief), by design.
      if (mode !== 'aventure') check('pedestrian ways ≥ 50 %', share(s, FOOT_WAYS) >= 0.5, fmtShares(s));
      check('no motorway / trunk', share(s, MOTOR_WAYS) === 0);
      check('primary / secondary ≤ 10 %', share(s, BUSY_WAYS) <= 0.1, fmtShares(s));
      check('flat running pace 9–13 km/h', s.distanceKm / (s.durationMin / 60) >= 9 && s.distanceKm / (s.durationMin / 60) <= 13,
        `${(s.distanceKm / (s.durationMin / 60)).toFixed(1)} km/h`);
    },
  },
  {
    label: 'Montmartre → Sacré-Cœur (running, steps)',
    activity: 'running',
    points: [{ lat: 48.884, lon: 2.3431 }, { lat: 48.8867, lon: 2.3431 }],
    assert: (s) => {
      check('route found under 1.5 km', s.distanceKm > 0 && s.distanceKm < 1.5, `${s.distanceKm.toFixed(2)} km`);
    },
  },
  {
    label: 'Chamonix → Lac Blanc (trail)',
    activity: 'trail',
    points: [{ lat: 45.9237, lon: 6.8694 }, { lat: 45.979, lon: 6.887 }],
    assert: (s, mode) => {
      check('paths & tracks ≥ 70 %', share(s, TRAIL_WAYS) >= 0.7, fmtShares(s));
      check(`SAC ≤ T${sacLimitFor('trail', mode)}`, s.maxSac <= sacLimitFor('trail', mode), `max T${s.maxSac}`);
      check('climbs (> 800 m D+)', s.ascentM > 800, `${s.ascentM} m`);
    },
  },
  {
    label: 'Annecy → Semnoz (trail)',
    activity: 'trail',
    points: [{ lat: 45.8992, lon: 6.1294 }, { lat: 45.7995, lon: 6.1003 }],
    assert: (s, mode) => {
      check('paths & tracks ≥ 70 %', share(s, TRAIL_WAYS) >= 0.7, fmtShares(s));
      check(`SAC ≤ T${sacLimitFor('trail', mode)}`, s.maxSac <= sacLimitFor('trail', mode), `max T${s.maxSac}`);
      check('no motorway / trunk', share(s, MOTOR_WAYS) === 0);
      check('primary / secondary ≤ 10 %', share(s, BUSY_WAYS) <= 0.1, fmtShares(s));
    },
  },
];

async function main(): Promise<void> {
  console.log(`BRouter upstream: ${UPSTREAM}\n`);

  console.log('Bike presets stay bike-only');
  for (const activity of ['road', 'gravel-default', 'mtb'] as const) {
    const brf = presetBrf(activity, 'vitesse');
    check(`${activity}: validForBikes, no foot directives`,
      brf.includes('assign validForBikes = true') && !brf.includes('validForFoot') && !brf.includes('sac_scale_limit'));
  }

  console.log(`\nStock fallback profile "${FOOT_FALLBACK_PROFILE}"`);
  try {
    const stats = await fetchRoute(FOOT_FALLBACK_PROFILE, SCENARIOS[2]!.points);
    check('exists on server', stats.distanceKm > 0, `${stats.distanceKm.toFixed(2)} km`);
  } catch (error) {
    check('exists on server', false, (error as Error).message);
  }

  const profileIds = new Map<string, string>();
  console.log('\nCompile Running / Trail presets');
  for (const activity of ['running', 'trail'] as const) {
    for (const mode of MODES) {
      const brf = presetBrf(activity, mode);
      check(`${activity}/${mode}: validForFoot`, brf.includes('assign validForFoot = true') && !brf.includes('validForBikes'));
      try {
        const id = await uploadProfile(brf);
        profileIds.set(`${activity}/${mode}`, id);
        check(`${activity}/${mode}: compiles (${brf.length} B)`, true, id);
      } catch (error) {
        check(`${activity}/${mode}: compiles`, false, (error as Error).message);
      }
    }
  }

  for (const scenario of SCENARIOS) {
    for (const mode of MODES) {
      const id = profileIds.get(`${scenario.activity}/${mode}`);
      if (!id) continue;
      console.log(`\n${scenario.label} — ${mode}`);
      try {
        const stats = await fetchRoute(id, scenario.points);
        console.log(`  ${stats.distanceKm.toFixed(2)} km, D+ ${stats.ascentM} m, ${stats.durationMin.toFixed(0)} min | ${fmtShares(stats)}`);
        check('no foot=no / private ways', stats.footForbiddenShare === 0);
        scenario.assert(stats, mode);
      } catch (error) {
        check('route computed', false, (error as Error).message);
      }
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

void main();
