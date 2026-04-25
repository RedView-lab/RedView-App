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

const HIKE_A_BIKE_SLOPE_PCT = 20;

interface ParsedMessageRow {
  lon: number;
  lat: number;
  wayTags: Record<string, string>;
}

interface FindingSeed {
  kind: ItineraryRouteAuditFinding['kind'];
  title: string;
  detail: string;
  startIndex: number;
  endIndex: number;
}

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
      wayTags: wayTagsIndex >= 0 ? parseWayTags(String(row[wayTagsIndex] ?? '')) : {},
    });
  }
  return rows;
}

function mergeAdjacentFindings(candidates: FindingSeed[]): FindingSeed[] {
  if (candidates.length === 0) return [];
  const merged: FindingSeed[] = [];

  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.kind === candidate.kind &&
      previous.title === candidate.title &&
      previous.detail === candidate.detail &&
      previous.endIndex === candidate.startIndex
    ) {
      previous.endIndex = candidate.endIndex;
      continue;
    }
    merged.push({ ...candidate });
  }

  return merged;
}

function segmentGradePct(points: RoutePoint[], endIndex: number): number {
  const point = points[endIndex];
  const fallback = Math.abs(Number(point?.gradientPct ?? 0));
  return Number.isFinite(fallback) ? fallback : 0;
}

function isOffroad(tags: Record<string, string>): boolean {
  return (
    OFFROAD_SURFACES.has(tags.surface ?? '') ||
    OFFROAD_HIGHWAYS.has(tags.highway ?? '') ||
    tags.tracktype === 'grade4' ||
    tags.tracktype === 'grade5'
  );
}

function isHikeABikeProbable(points: RoutePoint[], endIndex: number, tags: Record<string, string>): boolean {
  if (!isOffroad(tags)) return false;
  return segmentGradePct(points, endIndex) >= HIKE_A_BIKE_SLOPE_PCT;
}

export function analyzeBrouterRoute(
  route: BrouterRoute,
  points: RoutePoint[],
): ItineraryRouteAuditFinding[] {
  const rows = parseMessages(route);
  if (rows.length < 2 || points.length < 2) return [];

  const segmentCount = Math.min(rows.length, points.length);
  const candidates: FindingSeed[] = [];

  for (let index = 1; index < segmentCount; index++) {
    const tags = rows[index].wayTags;
    if (isHikeABikeProbable(points, index, tags)) {
      candidates.push({
        kind: 'hikeabike',
        title: 'Passage trop raide / portage probable',
        detail: 'Pente forte detectee sur terrain non roulant.',
        startIndex: index - 1,
        endIndex: index,
      });
    }
  }

  return mergeAdjacentFindings(candidates).map((finding, index) => ({
    id: `audit-${finding.kind}-${finding.startIndex}-${finding.endIndex}-${index}`,
    kind: finding.kind,
    title: finding.title,
    detail: finding.detail,
    coordinates: points
      .slice(finding.startIndex, finding.endIndex + 1)
      .map((point) => [point.lon, point.lat] as [number, number]),
  }));
}