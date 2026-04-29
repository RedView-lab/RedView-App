import type { PredictionResult } from '@/features/fitPredictor';
import {
  isInclinationMetric,
  isIntervalAverageMetric,
  metricIsAvailable,
  type AxisDomain,
  type AxisMode,
  type ChartMetricId,
  type ChartPoint,
  type RouteChartPoint,
} from './seriesCommon';
import {
  buildFixedDistanceAverageSeries,
  fitChartPointBudget,
  gradientPercentToDegrees,
  metricValueAtPoint,
  parseStartTimeHours,
  projectElapsedHoursToX,
} from './seriesPredictionMath';

export {
  formatAxisValue,
  isInclinationMetric,
  isIntervalAverageMetric,
  metricIsAvailable,
  unitForMetric,
} from './seriesCommon';
export type {
  AxisDomain,
  AxisMetricId,
  AxisMode,
  ChartBackdropProfile,
  ChartMetricId,
  ChartPoint,
  ChartSeries,
  RouteChartPoint,
} from './seriesCommon';

interface NormalizedRoutePoint {
  distanceM: number;
  elevationM: number;
  gradientPct: number;
}

interface TimelineSample {
  distanceM: number;
  elapsedHours: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const MAX_ROUTE_ALTITUDE_POINT_COUNT = 12_000;
const normalizedRouteProfileCache = new WeakMap<RouteChartPoint[], NormalizedRoutePoint[] | null>();
const routePointDistancesCache = new WeakMap<RouteChartPoint[], number[]>();
const predictionTimelineCache = new WeakMap<PredictionResult, TimelineSample[] | null>();
const predictionSeriesCache = new WeakMap<PredictionResult, Map<string, ChartPoint[] | null>>();
const routeBackedSeriesCache = new WeakMap<RouteChartPoint[], RouteBackedSeriesCacheBucket>();

interface RouteBackedSeriesCacheBucket {
  withoutPrediction: Map<string, ChartPoint[] | null>;
  withPrediction: WeakMap<PredictionResult, Map<string, ChartPoint[] | null>>;
}

function isRouteBackedMetric(metric: ChartMetricId): boolean {
  return metric === 'Altitude' || isInclinationMetric(metric);
}

function haversineM(a: RouteChartPoint, b: RouteChartPoint): number {
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

const GRADIENT_SEGMENT_M = 30;

function gradientWindowIndices(
  distances: number[],
  index: number,
  targetSpanM = GRADIENT_SEGMENT_M,
): { startIndex: number; endIndex: number } {
  const lastIndex = distances.length - 1;
  if (index <= 0) {
    let endIndex = 0;
    while (
      endIndex < lastIndex &&
      distances[endIndex] - distances[0] < targetSpanM
    ) {
      endIndex += 1;
    }
    return { startIndex: 0, endIndex };
  }
  if (index >= lastIndex) {
    let startIndex = lastIndex;
    while (
      startIndex > 0 &&
      distances[lastIndex] - distances[startIndex] < targetSpanM
    ) {
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

  while (
    endIndex < lastIndex &&
    distances[endIndex] - distances[startIndex] < targetSpanM
  ) {
    endIndex += 1;
  }
  while (
    startIndex > 0 &&
    distances[endIndex] - distances[startIndex] < targetSpanM
  ) {
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
  const { startIndex, endIndex } = gradientWindowIndices(
    distances,
    index,
    targetSpanM,
  );
  const spanM = distances[endIndex] - distances[startIndex];
  if (spanM <= 0.5) return 0;
  return ((elevations[endIndex] - elevations[startIndex]) / spanM) * 100;
}

function normalizeRouteProfile(
  routePoints: RouteChartPoint[] | null | undefined,
): NormalizedRoutePoint[] | null {
  if (!routePoints || routePoints.length < 2) return null;

  const cached = normalizedRouteProfileCache.get(routePoints);
  if (cached !== undefined) return cached;

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
    normalizedRouteProfileCache.set(routePoints, null);
    return null;
  }

  const smoothedElevations = smoothValues(
    samples.map((sample) => sample.elevationM),
    3,
  );
  const distances = samples.map((sample) => sample.distanceM);

  const normalized = samples.map((sample, index) => {
    const gradientPct = computeGradientPercentAtIndex(
      distances,
      smoothedElevations,
      index,
    );
    return {
      distanceM: sample.distanceM,
      elevationM: sample.elevationM,
      gradientPct,
    };
  });

  normalizedRouteProfileCache.set(routePoints, normalized);
  return normalized;
}

function getPredictionTimeline(
  prediction: PredictionResult | null | undefined,
): TimelineSample[] | null {
  if (!prediction || prediction.points.length < 2) return null;

  const cached = predictionTimelineCache.get(prediction);
  if (cached !== undefined) return cached;

  const timeline = prediction.points
    .map((point) => ({
      distanceM: point.distance_m,
      elapsedHours: point.elapsed_time_s / 3600,
    }))
    .filter(
      (point) => Number.isFinite(point.distanceM) && Number.isFinite(point.elapsedHours),
    );

  const result = timeline.length >= 2 ? timeline : null;
  predictionTimelineCache.set(prediction, result);
  return result;
}

function interpolateElapsedHoursFromTimeline(
  timeline: TimelineSample[] | null,
  distanceM: number,
): number | null {
  if (!timeline || timeline.length < 2) return null;

  if (distanceM <= timeline[0].distanceM) return timeline[0].elapsedHours;
  const last = timeline[timeline.length - 1];
  if (distanceM >= last.distanceM) return last.elapsedHours;

  let lo = 0;
  let hi = timeline.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (timeline[mid].distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = timeline[lo];
  const end = timeline[hi];
  const span = end.distanceM - start.distanceM;
  if (span <= 0) return start.elapsedHours;
  const t = (distanceM - start.distanceM) / span;
  return start.elapsedHours + (end.elapsedHours - start.elapsedHours) * t;
}

function getPredictionSeriesCacheMap(
  prediction: PredictionResult,
): Map<string, ChartPoint[] | null> {
  let cache = predictionSeriesCache.get(prediction);
  if (!cache) {
    cache = new Map<string, ChartPoint[] | null>();
    predictionSeriesCache.set(prediction, cache);
  }
  return cache;
}

function getRouteBackedSeriesCacheMap(
  routePoints: RouteChartPoint[],
  prediction: PredictionResult | null | undefined,
): Map<string, ChartPoint[] | null> {
  let bucket = routeBackedSeriesCache.get(routePoints);
  if (!bucket) {
    bucket = {
      withoutPrediction: new Map<string, ChartPoint[] | null>(),
      withPrediction: new WeakMap<PredictionResult, Map<string, ChartPoint[] | null>>(),
    };
    routeBackedSeriesCache.set(routePoints, bucket);
  }

  if (!prediction) return bucket.withoutPrediction;

  let cache = bucket.withPrediction.get(prediction);
  if (!cache) {
    cache = new Map<string, ChartPoint[] | null>();
    bucket.withPrediction.set(prediction, cache);
  }
  return cache;
}

function getRouteBackedSeriesCacheKey(
  metric: ChartMetricId,
  xMode: AxisMode,
  routeSource?: 'gpx' | 'brouter',
  startTime?: string | null,
): string {
  return [metric, xMode, routeSource ?? '', xMode === 'heure' ? startTime ?? '' : ''].join('|');
}

function getPredictionSeriesCacheKey(
  metric: ChartMetricId,
  xMode: AxisMode,
  startTime?: string | null,
): string {
  return [metric, xMode, xMode === 'heure' ? startTime ?? '' : ''].join('|');
}

function buildSeriesFromRouteProfile(
  routePoints: RouteChartPoint[] | null | undefined,
  prediction: PredictionResult | null | undefined,
  metric: ChartMetricId,
  xMode: AxisMode,
  routeSource?: 'gpx' | 'brouter',
  startTime?: string | null,
): ChartPoint[] | null {
  const profile = normalizeRouteProfile(routePoints);
  if (!profile) return null;

  const routeCache = routePoints
    ? getRouteBackedSeriesCacheMap(routePoints, xMode === 'distance' ? null : prediction)
    : null;
  const routeCacheKey = routePoints
    ? getRouteBackedSeriesCacheKey(metric, xMode, routeSource, startTime)
    : null;
  if (routeCache && routeCacheKey) {
    const cached = routeCache.get(routeCacheKey);
    if (cached !== undefined) return cached;
  }

  const timeline = xMode === 'distance' ? null : getPredictionTimeline(prediction);

  const points: ChartPoint[] = [];
  for (const sample of profile) {
    const x =
      xMode === 'distance'
        ? sample.distanceM / 1000
        : projectElapsedHoursToX(
            interpolateElapsedHoursFromTimeline(timeline, sample.distanceM),
            xMode,
            startTime,
          );
    const y =
      metric === 'Altitude'
        ? sample.elevationM
        : metric === 'Inclinaison (%)'
          ? sample.gradientPct
          : gradientPercentToDegrees(sample.gradientPct);

    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x: x as number, y });
    }
  }

  const result = points.length > 1
    ? fitChartPointBudget(
        points,
        metric === 'Altitude' && routeSource === 'gpx'
          ? MAX_ROUTE_ALTITUDE_POINT_COUNT
          : undefined,
      )
    : null;

  if (routeCache && routeCacheKey) {
    routeCache.set(routeCacheKey, result);
  }
  return result;
}

/**
 * Build a chart series from a prediction result. Returns `null` when the
 * prediction is unavailable or the metric is not supported.
 *
 * - `Vitesse`/`Puissance`/`Altitude`/`Inclinaison`: raw timeline value.
 * - `Vitesse moyenne`/`Puissance moyenne`: fixed 500 m interval averages,
 *   independent from the chart zoom level or visible graduations.
 * - X axis is the configurable distance (km) or elapsed time (h).
 */
export function buildSeriesFromPrediction(
  prediction: PredictionResult | null | undefined,
  metric: ChartMetricId,
  xMode: AxisMode,
  routePoints?: RouteChartPoint[] | null,
  routeSource?: 'gpx' | 'brouter',
  startTime?: string | null,
): ChartPoint[] | null {
  if (isRouteBackedMetric(metric)) {
    const routeSeries = buildSeriesFromRouteProfile(
      routePoints,
      prediction,
      metric,
      xMode,
      routeSource,
      startTime,
    );
    if (routeSeries) return routeSeries;
  }

  if (!prediction) return null;
  if (!prediction.points.length) return null;
  if (!metricIsAvailable(metric)) return null;

  const predictionCache = getPredictionSeriesCacheMap(prediction);
  const predictionCacheKey = getPredictionSeriesCacheKey(metric, xMode, startTime);
  const cached = predictionCache.get(predictionCacheKey);
  if (cached !== undefined) return cached;

  let result: ChartPoint[] | null = null;

  if (isIntervalAverageMetric(metric)) {
    const averageSeries = buildFixedDistanceAverageSeries(prediction, metric, xMode, startTime);
    if (averageSeries) {
      result = averageSeries;
      predictionCache.set(predictionCacheKey, result);
      return result;
    }
  }

  const points: ChartPoint[] = [];

  for (let i = 0; i < prediction.points.length; i++) {
    const p = prediction.points[i];
    const x =
      xMode === 'distance'
        ? p.distance_m / 1000
        : projectElapsedHoursToX(p.elapsed_time_s / 3600, xMode, startTime);
    const y = metricValueAtPoint(metric, p);

    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x, y });
    }
  }

  points.sort((a, b) => a.x - b.x);

  result = points.length > 1 ? fitChartPointBudget(points) : null;
  predictionCache.set(predictionCacheKey, result);
  return result;
}

export function locateRoutePointAtX(
  routePoints: RouteChartPoint[] | null | undefined,
  prediction: PredictionResult | null | undefined,
  xMode: AxisMode,
  xValue: number,
  startTime?: string | null,
): RouteChartPoint | null {
  if (!routePoints || routePoints.length === 0 || !Number.isFinite(xValue)) return null;

  const targetDistanceM = projectXToDistanceM(routePoints, prediction, xMode, xValue, startTime);
  if (!Number.isFinite(targetDistanceM)) return null;

  return interpolateRoutePointAtDistance(routePoints, targetDistanceM as number);
}

/** Compute a [min,max] domain over a list of series, padded by 5%. */
export function computeDomain(series: ChartPoint[][]): AxisDomain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const arr of series) {
    for (const p of arr) {
      if (p.y < min) min = p.y;
      if (p.y > max) max = p.y;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.05;
  let lo = min - pad;
  const hi = max + pad;
  // Anchor to zero when values stay non-negative — feels more natural for
  // speed/power/elevation curves.
  if (min >= 0 && lo < 0) lo = 0;
  return { min: lo, max: hi };
}

/** Compute the X axis domain from the union of all series. */
export function computeXDomain(series: ChartPoint[][], xMode: AxisMode): AxisDomain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const arr of series) {
    for (const p of arr) {
      if (p.x < min) min = p.x;
      if (p.x > max) max = p.x;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return null;
  if (xMode === 'heure') return { min, max };
  return { min: min >= 0 ? 0 : min, max };
}

function projectXToDistanceM(
  routePoints: RouteChartPoint[],
  prediction: PredictionResult | null | undefined,
  xMode: AxisMode,
  xValue: number,
  startTime?: string | null,
): number {
  if (xMode === 'distance') return xValue * 1000;

  const elapsedHours = xMode === 'heure'
    ? xValue - parseStartTimeHours(startTime)
    : xValue;
  if (!Number.isFinite(elapsedHours)) return Number.NaN;

  const timeline = getPredictionTimeline(prediction);
  const distanceFromTimeline = interpolateDistanceMFromElapsedHours(timeline, elapsedHours);
  if (Number.isFinite(distanceFromTimeline)) return distanceFromTimeline;

  const routeDistances = getRoutePointDistances(routePoints);
  const totalDistanceM = routeDistances[routeDistances.length - 1] ?? 0;
  if (!(totalDistanceM > 0)) return Number.NaN;

  const totalElapsedHours = prediction?.points.length
    ? (prediction.points[prediction.points.length - 1]?.elapsed_time_s ?? 0) / 3600
    : Number.NaN;
  if (!(totalElapsedHours > 0)) return Number.NaN;

  return (elapsedHours / totalElapsedHours) * totalDistanceM;
}

function interpolateDistanceMFromElapsedHours(
  timeline: TimelineSample[] | null,
  elapsedHours: number,
): number {
  if (!timeline || timeline.length < 2) return Number.NaN;
  if (elapsedHours <= timeline[0].elapsedHours) return timeline[0].distanceM;

  const last = timeline[timeline.length - 1];
  if (elapsedHours >= last.elapsedHours) return last.distanceM;

  let lo = 0;
  let hi = timeline.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (timeline[mid].elapsedHours <= elapsedHours) lo = mid;
    else hi = mid;
  }

  const start = timeline[lo];
  const end = timeline[hi];
  const span = end.elapsedHours - start.elapsedHours;
  if (span <= 0) return start.distanceM;
  const t = (elapsedHours - start.elapsedHours) / span;
  return start.distanceM + (end.distanceM - start.distanceM) * t;
}

function getRoutePointDistances(routePoints: RouteChartPoint[]): number[] {
  if (routePoints.length === 0) return [];

  const cached = routePointDistancesCache.get(routePoints);
  if (cached) return cached;

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

  routePointDistancesCache.set(routePoints, distances);
  return distances;
}

function interpolateRoutePointAtDistance(
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
