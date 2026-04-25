import type { BrouterRoute } from '../brouter';
import type { Itinerary, ItineraryRouteAuditFinding } from '../../types';

type RoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

const OFFROAD_SURFACES = new Set([
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
  'rock',
  'woodchips',
]);

const OFFROAD_HIGHWAYS = new Set([
  'track',
  'path',
  'footway',
  'bridleway',
]);

interface ParsedMessageRow {
  lon: number;
  lat: number;
  elevationM: number | null;
  segmentDistanceM: number;
  wayTags: Record<string, string>;
}

type SurfaceKind = 'tarmac' | 'offroad' | 'unknown';
type FindingCategory = 'extreme' | 'offroad-uphill' | 'offroad-downhill';

interface RouteSample {
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number | null;
  gradientPct: number | null;
  surface: SurfaceKind;
}

interface GradeWindow {
  startIndex: number;
  endIndex: number;
  spanM: number;
  gradePct: number;
  offroadShare: number;
  tarmacShare: number;
}

interface FindingSeed {
  kind: ItineraryRouteAuditFinding['kind'];
  category: FindingCategory;
  startIndex: number;
  endIndex: number;
  peakGradePct: number;
  spanM: number;
  offroadShare: number;
  tarmacShare: number;
}

const TARMAC_SURFACES = new Set([
  'asphalt',
  'paved',
  'concrete',
  'concrete:plates',
  'concrete:lanes',
  'paving_stones',
  'sett',
  'metal',
  'wood',
  'cobblestone',
  'unhewn_cobblestone',
  'chipseal',
]);

const TARMAC_HIGHWAYS = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'residential',
  'unclassified',
  'service',
  'living_street',
  'pedestrian',
  'road',
  'cycleway',
]);

const EARTH_RADIUS_M = 6_371_008.8;
const SHORT_WINDOW_M = 45;
const LONG_WINDOW_M = 90;
const EXTREME_SHORT_GRADE_PCT = 60;
const EXTREME_LONG_GRADE_PCT = 45;
const OFFROAD_UPHILL_SHORT_GRADE_PCT = 28;
const OFFROAD_UPHILL_LONG_GRADE_PCT = 18;
const OFFROAD_DOWNHILL_SHORT_GRADE_PCT = -32;
const OFFROAD_DOWNHILL_LONG_GRADE_PCT = -24;
const MIN_OFFROAD_SHARE = 0.35;
const MERGE_GAP_M = 35;

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

function parseMessages(route: BrouterRoute): ParsedMessageRow[] {
  const feature = route.raw.features?.[0];
  const props = (feature?.properties ?? {}) as { messages?: unknown[][] };
  const messages = props.messages;
  if (!Array.isArray(messages) || messages.length < 2) return [];

  const header = (messages[0] as unknown[]).map((entry) => String(entry));
  const lonIndex = header.indexOf('Longitude');
  const latIndex = header.indexOf('Latitude');
  const elevationIndex = header.indexOf('Elevation');
  const distanceIndex = header.indexOf('Distance');
  const wayTagsIndex = header.indexOf('WayTags');
  if (lonIndex < 0 || latIndex < 0) return [];

  const rows: ParsedMessageRow[] = [];
  for (let index = 1; index < messages.length; index++) {
    const row = messages[index];
    const lon = Number(row[lonIndex]) / 1e6;
    const lat = Number(row[latIndex]) / 1e6;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    rows.push({
      lon,
      lat,
      elevationM: elevationIndex >= 0 && Number.isFinite(Number(row[elevationIndex]))
        ? Number(row[elevationIndex])
        : null,
      segmentDistanceM: distanceIndex >= 0 && Number.isFinite(Number(row[distanceIndex]))
        ? Math.max(0, Number(row[distanceIndex]))
        : 0,
      wayTags: wayTagsIndex >= 0 ? parseWayTags(String(row[wayTagsIndex] ?? '')) : {},
    });
  }
  return rows;
}

function mergeAdjacentFindings(candidates: FindingSeed[], samples: RouteSample[]): FindingSeed[] {
  if (candidates.length === 0) return [];
  candidates.sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);
  const merged: FindingSeed[] = [];

  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    const gapM = previous
      ? Math.max(0, samples[candidate.startIndex].distanceM - samples[previous.endIndex].distanceM)
      : Number.POSITIVE_INFINITY;
    if (
      previous &&
      previous.category === candidate.category &&
      candidate.startIndex <= previous.endIndex + 1
    ) {
      previous.endIndex = Math.max(previous.endIndex, candidate.endIndex);
      previous.peakGradePct = Math.abs(candidate.peakGradePct) > Math.abs(previous.peakGradePct)
        ? candidate.peakGradePct
        : previous.peakGradePct;
      previous.spanM = Math.max(previous.spanM, candidate.spanM);
      previous.offroadShare = Math.max(previous.offroadShare, candidate.offroadShare);
      previous.tarmacShare = Math.max(previous.tarmacShare, candidate.tarmacShare);
      continue;
    }
    if (
      previous &&
      previous.category === candidate.category &&
      Number.isFinite(gapM) &&
      gapM <= MERGE_GAP_M
    ) {
      previous.endIndex = Math.max(previous.endIndex, candidate.endIndex);
      previous.peakGradePct = Math.abs(candidate.peakGradePct) > Math.abs(previous.peakGradePct)
        ? candidate.peakGradePct
        : previous.peakGradePct;
      previous.spanM = Math.max(previous.spanM, candidate.spanM);
      previous.offroadShare = Math.max(previous.offroadShare, candidate.offroadShare);
      previous.tarmacShare = Math.max(previous.tarmacShare, candidate.tarmacShare);
      continue;
    }
    merged.push({ ...candidate });
  }

  return merged;
}

function classifySurface(tags: Record<string, string>): SurfaceKind {
  if (tags.surface) {
    if (OFFROAD_SURFACES.has(tags.surface)) return 'offroad';
    if (TARMAC_SURFACES.has(tags.surface)) return 'tarmac';
  }
  if (tags.highway) {
    if (OFFROAD_HIGHWAYS.has(tags.highway)) return 'offroad';
    if (TARMAC_HIGHWAYS.has(tags.highway)) return 'tarmac';
  }
  if (tags.tracktype === 'grade4' || tags.tracktype === 'grade5') return 'offroad';
  return 'unknown';
}

function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRad(b.lat - a.lat);
  const deltaLon = toRad(b.lon - a.lon);
  const latA = toRad(a.lat);
  const latB = toRad(b.lat);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function buildCumulativeDistances(points: RoutePoint[], rows: ParsedMessageRow[]): number[] {
  const distances = new Array<number>(points.length).fill(0);
  let messageDistanceM = 0;

  for (let index = 1; index < points.length; index++) {
    const explicitDistanceM = points[index].distanceM;
    if (
      Number.isFinite(explicitDistanceM) &&
      (explicitDistanceM as number) >= distances[index - 1]
    ) {
      distances[index] = explicitDistanceM as number;
      continue;
    }

    if (rows[index]?.segmentDistanceM > 0) {
      messageDistanceM += rows[index].segmentDistanceM;
      distances[index] = Math.max(distances[index - 1], messageDistanceM);
      continue;
    }

    distances[index] = distances[index - 1] + haversineMeters(points[index - 1], points[index]);
  }

  return distances;
}

function findRowForPoint(
  rows: ParsedMessageRow[],
  point: RoutePoint,
  index: number,
): ParsedMessageRow | null {
  const direct = rows[index];
  if (direct && haversineMeters(point, direct) <= 12) return direct;

  const searchRadius = 8;
  const start = Math.max(0, index - searchRadius);
  const end = Math.min(rows.length - 1, index + searchRadius);
  let best: ParsedMessageRow | null = null;
  let bestDistanceM = Number.POSITIVE_INFINITY;

  for (let cursor = start; cursor <= end; cursor++) {
    const candidate = rows[cursor];
    const distanceM = haversineMeters(point, candidate);
    if (distanceM < bestDistanceM) {
      best = candidate;
      bestDistanceM = distanceM;
    }
  }

  return bestDistanceM <= 20 ? best : direct ?? null;
}

function buildSamples(points: RoutePoint[], rows: ParsedMessageRow[]): RouteSample[] {
  const distances = buildCumulativeDistances(points, rows);
  return points.map((point, index) => {
    const row = findRowForPoint(rows, point, index);
    const tags = row?.wayTags ?? {};
    const pointElevationM = Number(point.elevationM);
    const rowElevationM = Number(row?.elevationM);
    const gradientPct = Number(point.gradientPct);

    return {
      lat: point.lat,
      lon: point.lon,
      distanceM: distances[index],
      elevationM: Number.isFinite(pointElevationM)
        ? pointElevationM
        : Number.isFinite(rowElevationM)
          ? rowElevationM
          : null,
      gradientPct: Number.isFinite(gradientPct) ? gradientPct : null,
      surface: classifySurface(tags),
    };
  });
}

function gradientWindowIndices(
  samples: RouteSample[],
  index: number,
  targetSpanM: number,
): { startIndex: number; endIndex: number } {
  const lastIndex = samples.length - 1;
  const centerDistanceM = samples[index].distanceM;
  const halfSpanM = targetSpanM / 2;
  let startIndex = index;
  let endIndex = index;

  while (startIndex > 0 && centerDistanceM - samples[startIndex].distanceM < halfSpanM) {
    startIndex--;
  }
  while (endIndex < lastIndex && samples[endIndex].distanceM - centerDistanceM < halfSpanM) {
    endIndex++;
  }
  while (
    endIndex < lastIndex &&
    samples[endIndex].distanceM - samples[startIndex].distanceM < targetSpanM
  ) {
    endIndex++;
  }
  while (
    startIndex > 0 &&
    samples[endIndex].distanceM - samples[startIndex].distanceM < targetSpanM
  ) {
    startIndex--;
  }

  return { startIndex, endIndex };
}

function surfaceShares(samples: RouteSample[], startIndex: number, endIndex: number) {
  let totalM = 0;
  let offroadM = 0;
  let tarmacM = 0;

  for (let index = startIndex + 1; index <= endIndex; index++) {
    const segmentM = Math.max(0, samples[index].distanceM - samples[index - 1].distanceM);
    if (segmentM <= 0) continue;
    totalM += segmentM;
    if (samples[index].surface === 'offroad') offroadM += segmentM;
    else if (samples[index].surface === 'tarmac') tarmacM += segmentM;
  }

  if (totalM <= 0) {
    const window = samples.slice(startIndex, endIndex + 1);
    const offroadCount = window.filter((sample) => sample.surface === 'offroad').length;
    const tarmacCount = window.filter((sample) => sample.surface === 'tarmac').length;
    return {
      offroadShare: window.length > 0 ? offroadCount / window.length : 0,
      tarmacShare: window.length > 0 ? tarmacCount / window.length : 0,
    };
  }

  return {
    offroadShare: offroadM / totalM,
    tarmacShare: tarmacM / totalM,
  };
}

function computeGradeWindow(
  samples: RouteSample[],
  index: number,
  targetSpanM: number,
): GradeWindow | null {
  const { startIndex, endIndex } = gradientWindowIndices(samples, index, targetSpanM);
  const start = samples[startIndex];
  const end = samples[endIndex];
  const spanM = end.distanceM - start.distanceM;

  if (spanM <= 15 || start.elevationM == null || end.elevationM == null) {
    const fallbackGradePct = samples[index].gradientPct;
    if (fallbackGradePct == null || !Number.isFinite(fallbackGradePct)) return null;
    const shares = surfaceShares(samples, Math.max(0, index - 1), Math.min(samples.length - 1, index + 1));
    return {
      startIndex: Math.max(0, index - 1),
      endIndex: Math.min(samples.length - 1, index + 1),
      spanM: Math.max(spanM, 0),
      gradePct: fallbackGradePct,
      ...shares,
    };
  }

  const shares = surfaceShares(samples, startIndex, endIndex);
  return {
    startIndex,
    endIndex,
    spanM,
    gradePct: ((end.elevationM - start.elevationM) / spanM) * 100,
    ...shares,
  };
}

function chooseFindingWindow(shortWindow: GradeWindow | null, longWindow: GradeWindow | null) {
  const shortGrade = shortWindow?.gradePct ?? 0;
  const longGrade = longWindow?.gradePct ?? 0;
  const shortAbs = Math.abs(shortGrade);
  const longAbs = Math.abs(longGrade);

  if (shortWindow && shortAbs >= EXTREME_SHORT_GRADE_PCT) {
    return { category: 'extreme' as const, kind: 'steep' as const, window: shortWindow };
  }
  if (longWindow && longAbs >= EXTREME_LONG_GRADE_PCT) {
    return { category: 'extreme' as const, kind: 'steep' as const, window: longWindow };
  }

  const offroadWindow = longWindow && longWindow.offroadShare >= MIN_OFFROAD_SHARE ? longWindow : shortWindow;
  if (!offroadWindow || offroadWindow.offroadShare < MIN_OFFROAD_SHARE) return null;

  if (
    shortWindow &&
    shortWindow.offroadShare >= MIN_OFFROAD_SHARE &&
    shortWindow.gradePct >= OFFROAD_UPHILL_SHORT_GRADE_PCT
  ) {
    return { category: 'offroad-uphill' as const, kind: 'hikeabike' as const, window: shortWindow };
  }
  if (
    longWindow &&
    longWindow.offroadShare >= MIN_OFFROAD_SHARE &&
    longWindow.gradePct >= OFFROAD_UPHILL_LONG_GRADE_PCT
  ) {
    return { category: 'offroad-uphill' as const, kind: 'hikeabike' as const, window: longWindow };
  }
  if (
    shortWindow &&
    shortWindow.offroadShare >= MIN_OFFROAD_SHARE &&
    shortWindow.gradePct <= OFFROAD_DOWNHILL_SHORT_GRADE_PCT
  ) {
    return { category: 'offroad-downhill' as const, kind: 'steep' as const, window: shortWindow };
  }
  if (
    longWindow &&
    longWindow.offroadShare >= MIN_OFFROAD_SHARE &&
    longWindow.gradePct <= OFFROAD_DOWNHILL_LONG_GRADE_PCT
  ) {
    return { category: 'offroad-downhill' as const, kind: 'steep' as const, window: longWindow };
  }

  return null;
}

function findingTitle(category: FindingCategory): string {
  if (category === 'offroad-uphill') return 'Montée trop raide / portage probable';
  if (category === 'offroad-downhill') return 'Descente très raide / prudence';
  return 'Pente extrême détectée';
}

function findingDetail(finding: FindingSeed): string {
  const grade = formatSignedPercent(finding.peakGradePct);
  const degrees = formatDegrees(finding.peakGradePct);
  const distance = finding.spanM >= 100
    ? `${Math.round(finding.spanM / 10) * 10} m`
    : `${Math.round(finding.spanM)} m`;
  const surface = finding.offroadShare >= 0.6
    ? 'terrain majoritairement non roulant'
    : finding.tarmacShare >= 0.6
      ? 'route majoritairement roulante'
      : 'surface mixte ou mal renseignée';

  return `Pente fenêtrée jusqu'à ${grade} (${degrees}°) sur ~${distance}, ${surface}.`;
}

function formatSignedPercent(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function formatDegrees(value: number): string {
  return String(Math.round((Math.atan(Math.abs(value) / 100) * 180) / Math.PI));
}

export function analyzeBrouterRoute(
  route: BrouterRoute,
  points: RoutePoint[],
): ItineraryRouteAuditFinding[] {
  const rows = parseMessages(route);
  if (rows.length < 2 || points.length < 2) return [];

  const samples = buildSamples(points, rows);
  if (samples.length < 2) return [];

  const candidates: FindingSeed[] = [];

  for (let index = 0; index < samples.length; index++) {
    const shortWindow = computeGradeWindow(samples, index, SHORT_WINDOW_M);
    const longWindow = computeGradeWindow(samples, index, LONG_WINDOW_M);
    const decision = chooseFindingWindow(shortWindow, longWindow);
    if (decision) {
      const { window } = decision;
      candidates.push({
        kind: decision.kind,
        category: decision.category,
        startIndex: window.startIndex,
        endIndex: window.endIndex,
        peakGradePct: window.gradePct,
        spanM: window.spanM,
        offroadShare: window.offroadShare,
        tarmacShare: window.tarmacShare,
      });
    }
  }

  return mergeAdjacentFindings(candidates, samples).map((finding, index) => {
    const mergedSpanM = samples[finding.endIndex].distanceM - samples[finding.startIndex].distanceM;
    const findingWithSpan = { ...finding, spanM: Math.max(finding.spanM, mergedSpanM) };
    return {
      id: `audit-${finding.kind}-${finding.startIndex}-${finding.endIndex}-${index}`,
      kind: finding.kind,
      title: findingTitle(finding.category),
      detail: findingDetail(findingWithSpan),
      coordinates: samples
        .slice(finding.startIndex, finding.endIndex + 1)
        .map((sample) => [sample.lon, sample.lat] as [number, number]),
    };
  });
}