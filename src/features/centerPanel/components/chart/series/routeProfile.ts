import type { RouteChartPoint } from '../seriesCommon';
import { buildRouteContentSignature } from '@/features/itineraryPanel/lib/routes';

export interface NormalizedRoutePoint {
  distanceM: number;
  elevationM: number;
  gradientPct: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const GRADIENT_SEGMENT_M = 30;
const normalizedRouteProfileCache = new WeakMap<RouteChartPoint[], {
  signature: string;
  value: NormalizedRoutePoint[] | null;
}>();
const routePointDistancesCache = new WeakMap<RouteChartPoint[], {
  signature: string;
  value: number[];
}>();

export const MAX_ROUTE_ALTITUDE_POINT_COUNT = 12_000;

export function haversineM(a: RouteChartPoint, b: RouteChartPoint): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function smoothValues(values: number[], windowSize = 5): number[] {
  const out = new Array<number>(values.length);
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

function gradientWindowIndices(
  distances: number[],
  index: number,
  targetSpanM = GRADIENT_SEGMENT_M,
): { startIndex: number; endIndex: number } {
  const lastIndex = distances.length - 1;
  if (index <= 0) {
    let endIndex = 0;
    while (endIndex < lastIndex && distances[endIndex] - distances[0] < targetSpanM) {
      endIndex += 1;
    }
    return { startIndex: 0, endIndex };
  }
  if (index >= lastIndex) {
    let startIndex = lastIndex;
    while (startIndex > 0 && distances[lastIndex] - distances[startIndex] < targetSpanM) {
      startIndex -= 1;
    }
    return { startIndex, endIndex: lastIndex };
  }

  const minDistance = distances[0];
  const maxDistance = distances[lastIndex];
  const centerDistance = distances[index];
  const halfSpanM = targetSpanM / 2;
  let startTarget = centerDistance - halfSpanM;
  let endTarget = centerDistance + halfSpanM;

  if (startTarget < minDistance) {
    endTarget = Math.min(maxDistance, endTarget + (minDistance - startTarget));
    startTarget = minDistance;
  }
  if (endTarget > maxDistance) {
    startTarget = Math.max(minDistance, startTarget - (endTarget - maxDistance));
    endTarget = maxDistance;
  }

  let startIndex = index;
  while (startIndex > 0 && distances[startIndex] > startTarget) startIndex -= 1;

  let endIndex = index;
  while (endIndex < lastIndex && distances[endIndex] < endTarget) endIndex += 1;

  while (endIndex < lastIndex && distances[endIndex] - distances[startIndex] < targetSpanM) {
    endIndex += 1;
  }
  while (startIndex > 0 && distances[endIndex] - distances[startIndex] < targetSpanM) {
    startIndex -= 1;
  }

  return { startIndex, endIndex };
}

function computeGradientPercentAtIndex(
  distances: number[],
  elevations: number[],
  index: number,
  targetSpanM = GRADIENT_SEGMENT_M,
): number {
  const { startIndex, endIndex } = gradientWindowIndices(distances, index, targetSpanM);
  const spanM = distances[endIndex] - distances[startIndex];
  if (spanM <= 0.5) return 0;
  return ((elevations[endIndex] - elevations[startIndex]) / spanM) * 100;
}

export function normalizeRouteProfile(
  routePoints: RouteChartPoint[] | null | undefined,
): NormalizedRoutePoint[] | null {
  if (!routePoints || routePoints.length < 2) return null;

  const signature = buildRouteContentSignature(routePoints);

  const cached = normalizedRouteProfileCache.get(routePoints);
  if (cached !== undefined && cached.signature === signature) return cached.value;

  const samples: Array<{ distanceM: number; elevationM: number; gradientPct?: number | null }> = [];
  let cumulativeDistanceM = 0;

  for (let i = 0; i < routePoints.length; i++) {
    const point = routePoints[i];
    if (i > 0) {
      const nextDistance = point.distanceM;
      if (Number.isFinite(nextDistance) && (nextDistance as number) >= cumulativeDistanceM) {
        cumulativeDistanceM = nextDistance as number;
      } else {
        cumulativeDistanceM += haversineM(routePoints[i - 1], point);
      }
    }

    if (!Number.isFinite(point.elevationM)) continue;
    samples.push({
      distanceM: cumulativeDistanceM,
      elevationM: point.elevationM as number,
      gradientPct: point.gradientPct,
    });
  }

  if (samples.length < 2) {
    normalizedRouteProfileCache.set(routePoints, { signature, value: null });
    return null;
  }

  const smoothedElevations = smoothValues(samples.map((sample) => sample.elevationM), 3);
  const distances = samples.map((sample) => sample.distanceM);

  const normalized = samples.map((sample, index) => ({
    distanceM: sample.distanceM,
    elevationM: sample.elevationM,
    gradientPct: computeGradientPercentAtIndex(distances, smoothedElevations, index),
  }));

  normalizedRouteProfileCache.set(routePoints, { signature, value: normalized });
  return normalized;
}

export function getRoutePointDistances(routePoints: RouteChartPoint[]): number[] {
  if (routePoints.length === 0) return [];

  const signature = buildRouteContentSignature(routePoints);
  const cached = routePointDistancesCache.get(routePoints);
  if (cached && cached.signature === signature) return cached.value;

  const distances: number[] = [0];
  let cumulativeDistanceM = 0;
  for (let index = 1; index < routePoints.length; index += 1) {
    const point = routePoints[index];
    const nextDistance = point.distanceM;
    if (Number.isFinite(nextDistance) && (nextDistance as number) >= cumulativeDistanceM) {
      cumulativeDistanceM = nextDistance as number;
    } else {
      cumulativeDistanceM += haversineM(routePoints[index - 1], point);
    }
    distances.push(cumulativeDistanceM);
  }

  routePointDistancesCache.set(routePoints, { signature, value: distances });
  return distances;
}

export function interpolateRoutePointAtDistance(
  routePoints: RouteChartPoint[],
  targetDistanceM: number,
): RouteChartPoint | null {
  const distances = getRoutePointDistances(routePoints);
  if (distances.length === 0) return null;
  if (targetDistanceM <= distances[0]) return routePoints[0] ?? null;

  const lastIndex = distances.length - 1;
  if (targetDistanceM >= distances[lastIndex]) return routePoints[lastIndex] ?? null;

  let lo = 0;
  let hi = lastIndex;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (distances[mid] <= targetDistanceM) lo = mid;
    else hi = mid;
  }

  const startPoint = routePoints[lo];
  const endPoint = routePoints[hi];
  const span = distances[hi] - distances[lo];
  if (span <= 0) return startPoint;

  const t = Math.max(0, Math.min(1, (targetDistanceM - distances[lo]) / span));
  return {
    lat: startPoint.lat + (endPoint.lat - startPoint.lat) * t,
    lon: startPoint.lon + (endPoint.lon - startPoint.lon) * t,
    distanceM: targetDistanceM,
    elevationM:
      Number.isFinite(startPoint.elevationM) && Number.isFinite(endPoint.elevationM)
        ? (startPoint.elevationM as number) + ((endPoint.elevationM as number) - (startPoint.elevationM as number)) * t
        : startPoint.elevationM ?? endPoint.elevationM ?? null,
    gradientPct:
      Number.isFinite(startPoint.gradientPct) && Number.isFinite(endPoint.gradientPct)
        ? (startPoint.gradientPct as number) + ((endPoint.gradientPct as number) - (startPoint.gradientPct as number)) * t
        : startPoint.gradientPct ?? endPoint.gradientPct ?? null,
  };
}