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

interface RouteChunk {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  start: number;
  end: number;
}

const CHUNK_SIZE = 128;

function getRouteChunks(route: readonly ProjectedRoutePoint[]): RouteChunk[] {
  const cached = (route as { _chunks?: RouteChunk[] })._chunks;
  if (cached) return cached;

  const chunks: RouteChunk[] = [];
  const n = route.length;
  for (let start = 0; start < n - 1; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE, n - 1);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = start; i <= end; i++) {
      const p = route[i]!;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    chunks.push({ minX, maxX, minY, maxY, start, end });
  }
  try {
    (route as { _chunks?: RouteChunk[] })._chunks = chunks;
  } catch {}
  return chunks;
}

export function projectPoiOntoRoute(
  poi: PoiFeature,
  route: readonly ProjectedRoutePoint[],
  etaSecByPoint?: readonly number[],
): { progressM: number; lateralDistanceM: number; etaSec: number | null } {
  if (route.length === 0) {
    return { progressM: 0, lateralDistanceM: 0, etaSec: null };
  }
  if (route.length === 1) {
    const p = route[0]!;
    const refLat = poi.lat;
    const lonScale = Math.cos((refLat * Math.PI) / 180) * METERS_PER_DEG_LON;
    const latScale = METERS_PER_DEG_LAT;
    const px = poi.lon * lonScale;
    const py = poi.lat * latScale;
    const dx = px - p.x;
    const dy = py - p.y;
    return { progressM: p.progressM, lateralDistanceM: Math.sqrt(dx * dx + dy * dy), etaSec: etaSecByPoint?.[0] ?? null };
  }

  const refLat = poi.lat;
  const lonScale = Math.cos((refLat * Math.PI) / 180) * METERS_PER_DEG_LON;
  const latScale = METERS_PER_DEG_LAT;
  const px = poi.lon * lonScale;
  const py = poi.lat * latScale;

  let minDistanceSq = Infinity;
  let bestProgressM = 0;
  let bestSegmentIndex = 0;
  let bestSegmentT = 0;

  // 1. Échantillonnage grossier : borne supérieure rapide
  const stride = Math.max(1, Math.floor(route.length / 64));
  for (let i = 0; i < route.length; i += stride) {
    const pt = route[i]!;
    const dx = px - pt.x;
    const dy = py - pt.y;
    const dSq = dx * dx + dy * dy;
    if (dSq < minDistanceSq) {
      minDistanceSq = dSq;
      bestProgressM = pt.progressM;
      bestSegmentIndex = Math.min(i, route.length - 2);
      bestSegmentT = 0;
    }
  }

  let bestDist = Math.sqrt(minDistanceSq);

  // 2. Élagage spatial hiérarchique par paquets (chunks de 128 points)
  const chunks = getRouteChunks(route);
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;

    // Élimination du paquet entier de 128 segments en un seul test AABB
    if (
      px < chunk.minX - bestDist ||
      px > chunk.maxX + bestDist ||
      py < chunk.minY - bestDist ||
      py > chunk.maxY + bestDist
    ) {
      continue;
    }

    // Parcours fin des segments uniquement dans les paquets candidats
    for (let i = chunk.start; i < chunk.end; i++) {
      const a = route[i]!;
      const b = route[i + 1]!;

      const minX = (a.x < b.x ? a.x : b.x) - bestDist;
      if (px < minX) continue;
      const maxX = (a.x > b.x ? a.x : b.x) + bestDist;
      if (px > maxX) continue;
      const minY = (a.y < b.y ? a.y : b.y) - bestDist;
      if (py < minY) continue;
      const maxY = (a.y > b.y ? a.y : b.y) + bestDist;
      if (py > maxY) continue;

      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const apx = px - a.x;
      const apy = py - a.y;
      const segLenSq = abx * abx + aby * aby;

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
        bestDist = Math.sqrt(distSq);
        bestProgressM = a.progressM + t * Math.sqrt(segLenSq);
        bestSegmentIndex = i;
        bestSegmentT = t;
      }
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
    lateralDistanceM: bestDist,
    etaSec,
  };
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
