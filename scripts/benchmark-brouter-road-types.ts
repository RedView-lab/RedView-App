import { buildBrfProfile } from '../src/features/itineraryPanel/lib/brouter/brf-template';
import { resolveRoadTypes } from '../src/features/itineraryPanel/lib/brouter/road-types-resolver';
import type { BrouterRoute } from '../src/features/itineraryPanel/lib/brouter/types';
import { computeRouteSurfaceMetricsFromBrouter } from '../src/features/itineraryPanel/lib/route-metrics/metrics';
import type { PrioritiesState, RoadTypesState } from '../src/features/itineraryPanel/types';

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

type Point = { lat: number; lon: number };

type BrfBucket = 'road' | 'gravel' | 'singletrack' | 'offroad' | 'bikelane' | 'major' | 'other';

interface BenchmarkScenario {
  name: string;
  roadTypes: RoadTypesState;
}

interface SegmentRow {
  distanceM: number;
  tags: Record<string, string>;
}

interface RouteFeatureCollection {
  features?: Array<{
    geometry?: {
      coordinates?: [number, number][];
    };
    properties?: Record<string, unknown>;
  }>;
}

const UPSTREAM = process.env.BROUTER_UPSTREAM?.replace(/\/+$/, '') ?? 'http://135.116.81.157';
const WATCHDOG_RETRY_DELAYS_MS = [250, 700, 1500];
const ROUTE = {
  label: 'Autun → Clamecy (Morvan)',
  from: { lat: 46.9517, lon: 4.2994 },
  to: { lat: 47.4608, lon: 3.5203 },
} as const satisfies { label: string; from: Point; to: Point };

const NEUTRAL_PRIORITIES: PrioritiesState = {
  duration: 50,
  elevation: 50,
  distance: 50,
  tranquility: 50,
};

function roadTypes(overrides: Partial<RoadTypesState> = {}): RoadTypesState {
  return {
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
    ...overrides,
  };
}

const SCENARIOS: BenchmarkScenario[] = [
  {
    name: 'neutral-all-tolerate',
    roadTypes: roadTypes(),
  },
  {
    name: 'cities-avoid-only',
    roadTypes: roadTypes({ cities: 'avoid' }),
  },
  {
    name: 'cities-forbid-only',
    roadTypes: roadTypes({ cities: 'forbid' }),
  },
  {
    name: 'road-forbid-only',
    roadTypes: roadTypes({ road: 'forbid' }),
  },
  {
    name: 'road-and-major-forbid',
    roadTypes: roadTypes({ road: 'forbid', majorRoads: 'forbid' }),
  },
  {
    name: 'screenshot-like',
    roadTypes: roadTypes({
      road: 'forbid',
      gravel: 'prefer',
      offroad: 'forbid',
      majorRoads: 'avoid',
      turns: 'avoid',
      maxSlopePercent: 20,
    }),
  },
];

function parseWayTags(tagsStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tagsStr) return out;

  for (const pair of tagsStr.split(/\s+/)) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex <= 0) continue;
    out[pair.slice(0, separatorIndex)] = pair.slice(separatorIndex + 1);
  }

  return out;
}

function isWatchdogMessage(message: string): boolean {
  return /thread-priority-watchdog/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasCycleway(tags: Record<string, string>): boolean {
  const isPositive = (value: string | undefined): boolean => (
    value != null && value !== '' && value !== 'no' && value !== 'none'
  );
  return isPositive(tags.cycleway) || isPositive(tags['cycleway:left']) || isPositive(tags['cycleway:right']);
}

function isUnpaved(tags: Record<string, string>): boolean {
  const surface = tags.surface ?? '';
  if ([
    'unpaved',
    'gravel',
    'fine_gravel',
    'compacted',
    'dirt',
    'earth',
    'ground',
    'grass',
    'mud',
    'sand',
    'pebblestone',
    'rock',
    'woodchips',
  ].includes(surface)) return true;

  return ['grade1', 'grade2', 'grade3', 'grade4', 'grade5'].includes(tags.tracktype ?? '');
}

function classifyBrfBucket(tags: Record<string, string>): BrfBucket {
  const highway = tags.highway ?? '';
  const isResidentialOrLiving =
    highway === 'residential' ||
    highway === 'living_street' ||
    tags.living_street === 'yes';

  if (highway === 'cycleway' || (isResidentialOrLiving && hasCycleway(tags))) return 'bikelane';
  if (['trunk', 'trunk_link', 'primary', 'primary_link'].includes(highway)) return 'major';
  if (highway === 'path' || highway === 'footway') return 'singletrack';
  if (highway === 'bridleway') return 'offroad';

  if (highway === 'track') {
    if (['grade3', 'grade4', 'grade5'].includes(tags.tracktype ?? '')) return 'offroad';
    return 'gravel';
  }

  if (
    isUnpaved(tags) &&
    ['secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street'].includes(highway)
  ) {
    return 'gravel';
  }

  if (
    !isUnpaved(tags) &&
    ['secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service'].includes(highway)
  ) {
    return 'road';
  }

  return 'other';
}

function parseSegmentRows(route: BrouterRoute): SegmentRow[] {
  const feature = route.raw.features?.[0];
  const props = (feature?.properties ?? {}) as { messages?: unknown[][] };
  const messages = props.messages;
  if (!Array.isArray(messages) || messages.length < 2) return [];

  const header = (messages[0] as unknown[]).map((entry) => String(entry));
  const distIndex = header.indexOf('Distance');
  const tagsIndex = header.indexOf('WayTags');
  if (distIndex < 0 || tagsIndex < 0) return [];

  const rows: SegmentRow[] = [];
  for (let index = 1; index < messages.length; index += 1) {
    const row = messages[index] as unknown[];
    rows.push({
      distanceM: Number(row[distIndex]) || 0,
      tags: parseWayTags(String(row[tagsIndex] ?? '')),
    });
  }
  return rows;
}

function percentagesFromMap(values: Map<string, number>, totalM: number): Record<string, number> {
  return Object.fromEntries(
    [...values.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([key, value]) => [key, Number(((value / Math.max(1, totalM)) * 100).toFixed(1))]),
  );
}

function buildRoute(routeFeatureCollection: RouteFeatureCollection): BrouterRoute {
  const props = (routeFeatureCollection.features?.[0]?.properties ?? {}) as Record<string, unknown>;
  const plainAscend = Number(props['plain-ascend']) || 0;
  const filteredAscend = Number(props['filtered ascend']) || 0;

  return {
    coordinates: routeFeatureCollection.features?.[0]?.geometry?.coordinates ?? [],
    distanceM: Number(props['track-length']) || 0,
    durationS: Number(props['total-time']) || 0,
    ascentM: filteredAscend,
    descentM: plainAscend - filteredAscend,
    raw: routeFeatureCollection,
  };
}

async function uploadProfile(brf: string): Promise<string> {
  const response = await fetch(`${UPSTREAM}/brouter/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    body: brf,
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`upload HTTP ${response.status}: ${text.slice(0, 200)}`);

  const body = JSON.parse(text) as { profileid?: string; error?: string };
  if (body.error) throw new Error(`profile compile error: ${body.error}`);
  if (!body.profileid) throw new Error(`no profileid in response: ${text.slice(0, 200)}`);
  return body.profileid;
}

async function fetchRoute(profileId: string): Promise<BrouterRoute> {
  const lonlats = `${ROUTE.from.lon},${ROUTE.from.lat}|${ROUTE.to.lon},${ROUTE.to.lat}`;
  const url = `${UPSTREAM}/brouter?lonlats=${lonlats}&profile=${profileId}&format=geojson&alternativeidx=0`;

  let lastError = 'route fetch failed';
  for (let attempt = 0; attempt <= WATCHDOG_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await fetch(url);
    const text = await response.text();
    const isJson = (response.headers.get('content-type') ?? '').includes('json');
    const isTextError = text.trimStart().toLowerCase().startsWith('error');

    if (response.ok && isJson && !isTextError) {
      return buildRoute(JSON.parse(text) as RouteFeatureCollection);
    }

    lastError = response.ok
      ? text.slice(0, 200)
      : `route HTTP ${response.status}: ${text.slice(0, 200)}`;
    if (isWatchdogMessage(lastError) && attempt < WATCHDOG_RETRY_DELAYS_MS.length) {
      await delay(WATCHDOG_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw new Error(lastError);
  }

  throw new Error(lastError);
}

function analyze(route: BrouterRoute): {
  distanceKm: number;
  ascentM: number;
  durationMin: number;
  uiSurface: { tarmacPercent: number; offroadPercent: number } | null;
  brfBuckets: Record<string, number>;
  topHighways: Record<string, number>;
} {
  const uiSurfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);
  const rows = parseSegmentRows(route);
  const bucketDistances = new Map<string, number>();
  const highwayDistances = new Map<string, number>();

  let totalM = 0;
  for (const row of rows) {
    totalM += row.distanceM;
    const bucket = classifyBrfBucket(row.tags);
    const highway = row.tags.highway || 'unknown';
    bucketDistances.set(bucket, (bucketDistances.get(bucket) ?? 0) + row.distanceM);
    highwayDistances.set(highway, (highwayDistances.get(highway) ?? 0) + row.distanceM);
  }

  const topHighways = new Map(
    [...highwayDistances.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8),
  );

  return {
    distanceKm: Number((route.distanceM / 1000).toFixed(1)),
    ascentM: Math.round(route.ascentM),
    durationMin: Math.round(route.durationS / 60),
    uiSurface: uiSurfaceMetrics
      ? {
        tarmacPercent: Number(uiSurfaceMetrics.tarmacPercent.toFixed(1)),
        offroadPercent: Number(uiSurfaceMetrics.offroadPercent.toFixed(1)),
      }
      : null,
    brfBuckets: percentagesFromMap(bucketDistances, totalM),
    topHighways: percentagesFromMap(topHighways, totalM),
  };
}

async function main(): Promise<void> {
  console.log(`BRouter upstream : ${UPSTREAM}`);
  console.log(`Route            : ${ROUTE.label}`);
  console.log(`                   ${ROUTE.from.lat},${ROUTE.from.lon} → ${ROUTE.to.lat},${ROUTE.to.lon}\n`);

  const results = [] as Array<Record<string, unknown>>;
  for (const scenario of SCENARIOS) {
    const resolved = resolveRoadTypes(scenario.roadTypes);
    const brf = buildBrfProfile({
      priorities: NEUTRAL_PRIORITIES,
      roadTypes: resolved.effective,
      expert: null,
    });
    const profileId = await uploadProfile(brf);
    const route = await fetchRoute(profileId);
    results.push({
      scenario: scenario.name,
      profileId,
      warnings: resolved.warnings,
      roadTypes: resolved.effective,
      ...analyze(route),
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
});