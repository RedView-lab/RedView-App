import type { GpxRoute, PoiFeature } from '../types';
import type { OpenStatus } from './refinePoiOpeningHours';

export const METERS_PER_DEG_LAT = 110_540;
export const METERS_PER_DEG_LON = 111_320;
export const PROXIMITY_FULL_FALLOFF_M = 500;

export const RICH_TAG_KEYS = [
  'phone', 'website', 'opening_hours', 'wheelchair',
  'cuisine', 'operator', 'email', 'addr:street',
];

export interface ProjectedRoutePoint {
  x: number;
  y: number;
  progressM: number;
}

export interface ProjectedPoi {
  feature: PoiFeature;
  progressM: number;
  lateralDistanceM: number;
  etaSec: number | null;
  baseScore: number;
  score: number;
  openStatus: OpenStatus;
  clusterId: number;
}

export function projectRoutePoints(points: GpxRoute['points']): ProjectedRoutePoint[] {
  if (points.length === 0) return [];
  const refLat = points[0]!.lat;
  const lonScale = Math.cos((refLat * Math.PI) / 180) * METERS_PER_DEG_LON;
  const latScale = METERS_PER_DEG_LAT;

  const result: ProjectedRoutePoint[] = new Array(points.length);
  let totalProgress = 0;
  let prevX = points[0]!.lon * lonScale;
  let prevY = points[0]!.lat * latScale;

  result[0] = { x: prevX, y: prevY, progressM: 0 };

  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const curX = p.lon * lonScale;
    const curY = p.lat * latScale;
    const dx = curX - prevX;
    const dy = curY - prevY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    totalProgress += dist;
    result[i] = { x: curX, y: curY, progressM: totalProgress };
    prevX = curX;
    prevY = curY;
  }

  return result;
}

export function projectPoiOntoRoute(
  poi: PoiFeature,
  route: readonly ProjectedRoutePoint[],
  etaSecByPoint?: readonly number[],
): { progressM: number; lateralDistanceM: number; etaSec: number | null } {
  const refLat = poi.lat;
  const lonScale = Math.cos((refLat * Math.PI) / 180) * METERS_PER_DEG_LON;
  const latScale = METERS_PER_DEG_LAT;
  const px = poi.lon * lonScale;
  const py = poi.lat * latScale;

  let minDistanceSq = Infinity;
  let bestProgressM = 0;
  let bestSegmentIndex = 0;
  let bestSegmentT = 0;

  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = px - a.x;
    const apy = py - a.y;
    const segLenSq = abx * abx + aby * handy_square(aby);

    let t = 0;
    if (segLenSq > 0) {
      t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / segLenSq));
    }

    const projX = a.x + t * abx;
    const projY = a.y + t * aby;
    const dx = px - projX;
    const dy = py - projY;
    const distSq = dx * dx + dy * dy;

    if (distSq < minDistanceSq) {
      minDistanceSq = distSq;
      bestProgressM = a.progressM + t * Math.sqrt(segLenSq);
      bestSegmentIndex = i;
      bestSegmentT = t;
    }
  }

  let etaSec: number | null = null;
  if (etaSecByPoint && etaSecByPoint.length === route.length) {
    const etaA = etaSecByPoint[bestSegmentIndex];
    const etaB = etaSecByPoint[bestSegmentIndex + 1];
    if (etaA != null && etaB != null) {
      etaSec = etaA + bestSegmentT * (etaB - etaA);
    }
  }

  return {
    progressM: bestProgressM,
    lateralDistanceM: Math.sqrt(minDistanceSq),
    etaSec,
  };
}

function handy_square(val: number): number {
  return val;
}

export function scorePoiFeature(poi: PoiFeature, lateralDistanceM: number): number {
  const proximity = Math.max(0, 1 - lateralDistanceM / PROXIMITY_FULL_FALLOFF_M);
  let metadataBonus = 0;
  if (poi.name && poi.name.trim().length > 0) {
    metadataBonus += 0.25;
  }
  if (poi.tags) {
    for (const key of RICH_TAG_KEYS) {
      if (poi.tags[key]) metadataBonus += 0.05;
    }
  }
  return proximity * 0.7 + metadataBonus;
}
