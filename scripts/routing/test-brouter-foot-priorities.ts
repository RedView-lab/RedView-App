/**
 * Priority sliders & « Paramètres additionnels » on the pedestrian BRF —
 * the foot counterpart of the E / D / X / T / Q / S groups of
 * scripts/routing/test-brouter-scenarios.ts.
 *
 *   npx tsx scripts/routing/test-brouter-foot-priorities.ts
 *   BROUTER_UPSTREAM=http://<vps> npx tsx scripts/routing/test-brouter-foot-priorities.ts
 *
 * Routes are requested like the app does for custom profiles
 * (routingStrategy.ts → single BRouter query): every priority effect must
 * therefore come from the generated BRF itself.
 */
import { buildBrfProfile } from '../../src/features/itineraryPanel/lib/brouter/profiles/brf-template';
import { syncTracageOnActivityChange } from '../../src/features/itineraryPanel/lib/project/syncTracageParams';
import type {
  PrioritiesState,
  RoadPreference,
  RoadTypesState,
} from '../../src/features/itineraryPanel/types';
import type { FootDiscipline } from '../../src/shared/lib/discipline';

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

const UPSTREAM =
  process.env.BROUTER_UPSTREAM?.replace(/\/+$/, '').replace(/\/brouter$/, '') ?? 'http://localhost:17777';

type Point = { lat: number; lon: number };

interface FootRoute {
  label: string;
  discipline: FootDiscipline;
  from: Point;
  to: Point;
}

const ROUTES: FootRoute[] = [
  {
    label: 'Lyon Part-Dieu → Vaise (running, Croix-Rousse / Fourvière)',
    discipline: 'running',
    from: { lat: 45.7605, lon: 4.859 },
    to: { lat: 45.774, lon: 4.805 },
  },
  {
    label: 'Annecy → Talloires (trail, Mont Veyrier)',
    discipline: 'trail',
    from: { lat: 45.8992, lon: 6.1294 },
    to: { lat: 45.841, lon: 6.214 },
  },
  {
    label: 'Chamonix → Les Houches (trail, Balcons)',
    discipline: 'trail',
    from: { lat: 45.9237, lon: 6.8694 },
    to: { lat: 45.8905, lon: 6.7985 },
  },
];

const NEUTRAL: PrioritiesState = { duration: 50, elevation: 50, distance: 50, tranquility: 50 };
const BUSY_WAYS = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link']);

interface Stats {
  distanceKm: number;
  ascentM: number;
  durationMin: number;
  busyShare: number;
  maxGradePct: number;
}

/** Vitesse preset of the discipline, with the slider-neutral elevation knob. */
function presetRoadTypes(discipline: FootDiscipline, over: Partial<RoadTypesState> = {}): RoadTypesState {
  const sync = syncTracageOnActivityChange(discipline, 'vitesse', 10);
  const roadTypes = { ...(sync.roadTypes as RoadTypesState), applyToAllItineraries: false };
  delete roadTypes.elevationPreference;
  return { ...roadTypes, ...over };
}

async function uploadProfile(brf: string): Promise<string> {
  const res = await fetch(`${UPSTREAM}/brouter/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    body: brf,
  });
  const json = JSON.parse(await res.text()) as { profileid?: string; error?: string };
  if (json.error || !json.profileid) throw new Error(`profile compile error: ${json.error ?? 'no id'}`);
  return json.profileid;
}

async function route(
  r: FootRoute,
  priorities: PrioritiesState,
  roadTypes: RoadTypesState,
): Promise<Stats> {
  const profile = await uploadProfile(buildBrfProfile({ priorities, roadTypes, discipline: r.discipline }));
  const lonlats = `${r.from.lon},${r.from.lat}|${r.to.lon},${r.to.lat}`;
  const res = await fetch(`${UPSTREAM}/brouter?lonlats=${lonlats}&profile=${profile}&format=geojson`);
  const text = await res.text();
  if (!res.ok || !text.trimStart().startsWith('{')) throw new Error(`route HTTP ${res.status}: ${text.slice(0, 160)}`);
  const props = (JSON.parse(text) as {
    features: { properties: Record<string, unknown> & { messages: string[][] } }[];
  }).features[0]!.properties;
  const [header, ...rows] = props.messages;
  const distIdx = header!.indexOf('Distance');
  const elevIdx = header!.indexOf('Elevation');
  const tagsIdx = header!.indexOf('WayTags');
  const total = Number(props['track-length']);
  let busy = 0;
  let maxGrade = 0;
  let prevElev: number | null = null;
  for (const row of rows) {
    const dist = Number(row[distIdx]);
    const elev = Number(row[elevIdx]);
    const highway = /(?:^|\s)highway=(\S+)/.exec(row[tagsIdx] ?? '')?.[1] ?? '';
    if (BUSY_WAYS.has(highway)) busy += dist;
    if (prevElev != null && dist >= 40) maxGrade = Math.max(maxGrade, (100 * Math.abs(elev - prevElev)) / dist);
    prevElev = elev;
  }
  return {
    distanceKm: total / 1000,
    ascentM: Number(props['filtered ascend']),
    durationMin: Number(props['total-time']) / 60,
    busyShare: total > 0 ? busy / total : 0,
    maxGradePct: maxGrade,
  };
}

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`    ${ok ? '✅' : '❌'} ${label}  (${detail})`);
}

function row(name: string, s: Stats): void {
  console.log(
    `  ${name.padEnd(30)} ${s.distanceKm.toFixed(2).padStart(6)} km  D+ ${String(Math.round(s.ascentM)).padStart(5)} m  ` +
      `${s.durationMin.toFixed(0).padStart(4)} min  busy ${(s.busyShare * 100).toFixed(0).padStart(2)} %`,
  );
}

async function group(
  r: FootRoute,
  title: string,
  scenarios: { name: string; priorities?: Partial<PrioritiesState>; roadTypes?: Partial<RoadTypesState> }[],
): Promise<Stats[]> {
  console.log(`\n  ── ${title}`);
  const out: Stats[] = [];
  for (const s of scenarios) {
    const stats = await route(r, { ...NEUTRAL, ...s.priorities }, presetRoadTypes(r.discipline, s.roadTypes));
    row(s.name, stats);
    out.push(stats);
  }
  return out;
}

async function runRoute(r: FootRoute): Promise<void> {
  console.log(`\n══ ${r.label}`);

  const e = await group(r, 'E — Dénivelé slider', [
    { name: 'E0 elevation=0   max-flat', priorities: { elevation: 0 } },
    { name: 'E2 elevation=50  neutral', priorities: { elevation: 50 } },
    { name: 'E4 elevation=100 max D+', priorities: { elevation: 100 } },
  ]);
  check('max D+ climbs more than neutral', e[2]!.ascentM > e[1]!.ascentM, `${Math.round(e[1]!.ascentM)} → ${Math.round(e[2]!.ascentM)} m`);
  check('max-flat climbs no more than neutral', e[0]!.ascentM <= e[1]!.ascentM, `${Math.round(e[1]!.ascentM)} → ${Math.round(e[0]!.ascentM)} m`);

  const prefs: RoadPreference[] = ['forbid', 'avoid', 'tolerate', 'prefer'];
  const p = await group(r, '« Dénivelé » additional parameter', prefs.map((pref) => ({
    name: `P ${pref}`,
    roadTypes: { elevationPreference: pref },
  })));
  check('Privilégier ≥ Tolérer (D+)', p[3]!.ascentM >= p[2]!.ascentM, `${Math.round(p[2]!.ascentM)} → ${Math.round(p[3]!.ascentM)} m`);
  check('Privilégier > Interdire (D+)', p[3]!.ascentM > p[0]!.ascentM, `${Math.round(p[0]!.ascentM)} → ${Math.round(p[3]!.ascentM)} m`);
  check('Interdire ≤ Tolérer (D+)', p[0]!.ascentM <= p[2]!.ascentM, `${Math.round(p[2]!.ascentM)} → ${Math.round(p[0]!.ascentM)} m`);

  const d = await group(r, 'D — Distance slider', [
    { name: 'D0 distance=0   shortest', priorities: { distance: 0 } },
    { name: 'D1 distance=50  neutral', priorities: { distance: 50 } },
    { name: 'D2 distance=100 max distance', priorities: { distance: 100 } },
  ]);
  check('shortest ≤ neutral (km)', d[0]!.distanceKm <= d[1]!.distanceKm + 0.05, `${d[1]!.distanceKm.toFixed(2)} → ${d[0]!.distanceKm.toFixed(2)} km`);
  check('max distance > shortest (km)', d[2]!.distanceKm > d[0]!.distanceKm, `${d[0]!.distanceKm.toFixed(2)} → ${d[2]!.distanceKm.toFixed(2)} km`);

  const x = await group(r, 'X — max distance + max D+', [
    { name: 'X0 neutral', priorities: {} },
    { name: 'X2 distance=100 elevation=100', priorities: { distance: 100, elevation: 100 } },
  ]);
  check('max distance + max D+ climbs more', x[1]!.ascentM > x[0]!.ascentM, `${Math.round(x[0]!.ascentM)} → ${Math.round(x[1]!.ascentM)} m`);

  const t = await group(r, 'T — Durée slider', [
    { name: 'T0 duration=0   no rush', priorities: { duration: 0 } },
    { name: 'T2 duration=100 fast', priorities: { duration: 100 } },
  ]);
  check('fast is not slower (BRouter time)', t[1]!.durationMin <= t[0]!.durationMin + 0.5, `${t[0]!.durationMin.toFixed(0)} → ${t[1]!.durationMin.toFixed(0)} min`);

  const q = await group(r, 'Q — Tranquilité slider', [
    { name: 'Q0 tranquility=0   traffic OK', priorities: { tranquility: 0 } },
    { name: 'Q2 tranquility=100 max quiet', priorities: { tranquility: 100 } },
  ]);
  check('max quiet has no more busy roads', q[1]!.busyShare <= q[0]!.busyShare + 0.01, `${(q[0]!.busyShare * 100).toFixed(0)} → ${(q[1]!.busyShare * 100).toFixed(0)} %`);

  const s = await group(r, 'S — Pentes max.', [
    { name: 'S0 maxSlope=50', roadTypes: { maxSlopePercent: 50 } },
    { name: 'S2 maxSlope=8', roadTypes: { maxSlopePercent: 8 } },
  ]);
  check('8 % cap: gentler or longer', s[1]!.maxGradePct <= s[0]!.maxGradePct + 1 || s[1]!.distanceKm > s[0]!.distanceKm,
    `max grade ${s[0]!.maxGradePct.toFixed(0)} → ${s[1]!.maxGradePct.toFixed(0)} %, ${s[0]!.distanceKm.toFixed(2)} → ${s[1]!.distanceKm.toFixed(2)} km`);
}

async function main(): Promise<void> {
  console.log(`BRouter upstream: ${UPSTREAM}`);
  for (const r of ROUTES) {
    try {
      await runRoute(r);
    } catch (error) {
      checks += 1;
      failures += 1;
      console.log(`    ❌ ${r.label}: ${(error as Error).message}`);
    }
  }
  console.log(`\nChecks: ${checks}  Passed: ${checks - failures}  Failed: ${failures}`);
  if (failures > 0) process.exitCode = 1;
}

void main();
