import type { PredictionResult } from '@/features/fitPredictor';
import { buildPauseAwareSchedule, type PauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { metricIsAvailable, type AxisDomain, type AxisMode, type ChartMetricId, type ChartPoint, type RouteChartPoint } from '../seriesCommon';
import {
  buildFixedDistanceAverageSeries,
  fitChartPointBudget,
  gradientPercentToDegrees,
  metricValueAtPoint,
  parseStartTimeHours,
} from '../seriesPredictionMath';
import {
  getPredictionSeriesCacheKey,
  getPredictionSeriesCacheMap,
  getRouteBackedSeriesCacheKey,
  getRouteBackedSeriesCacheMap,
} from './cache';
import {
  getRoutePointDistances,
  interpolateRoutePointAtDistance,
  MAX_ROUTE_ALTITUDE_POINT_COUNT,
  normalizeRouteProfile,
} from './routeProfile';
import {
  getPredictionTimeline,
  insertPauseSegments,
  interpolateDistanceMFromElapsedHours,
  interpolateElapsedHoursFromTimeline,
  isPauseZeroMetric,
  projectPredictionElapsedHoursToX,
} from './timeline';

function isRouteBackedMetric(metric: ChartMetricId): boolean {
  return metric === 'Altitude' || metric === 'Inclinaison (°)' || metric === 'Inclinaison (%)';
}

function buildSeriesFromRouteProfile(
  routePoints: RouteChartPoint[] | null | undefined,
  prediction: PredictionResult | null | undefined,
  metric: ChartMetricId,
  xMode: AxisMode,
  routeSource?: 'gpx' | 'brouter',
  startTime?: string | null,
  pauseSchedule?: PauseAwareSchedule | null,
): ChartPoint[] | null {
  const profile = normalizeRouteProfile(routePoints);
  if (!profile) return null;

  const routeCache = routePoints
    ? getRouteBackedSeriesCacheMap(routePoints, xMode === 'distance' ? null : prediction)
    : null;
  const routeCacheKey = routePoints
    ? getRouteBackedSeriesCacheKey(metric, xMode, routeSource, startTime, pauseSchedule?.pauseSignature)
    : null;
  if (routeCache && routeCacheKey) {
    const cached = routeCache.get(routeCacheKey);
    if (cached !== undefined) return cached;
  }

  const timeline = xMode === 'distance' ? null : getPredictionTimeline(prediction);

  const points: ChartPoint[] = [];
  for (const sample of profile) {
    const elapsedHours = interpolateElapsedHoursFromTimeline(timeline, sample.distanceM);
    const x =
      xMode === 'distance'
        ? sample.distanceM / 1000
        : projectPredictionElapsedHoursToX(elapsedHours, xMode, startTime, pauseSchedule);
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

  const pointsWithPauses = xMode === 'distance'
    ? points
    : insertPauseSegments(points, pauseSchedule?.pauseSpans ?? [], xMode, startTime, () => null);

  const result = pointsWithPauses.length > 1
    ? fitChartPointBudget(
        pointsWithPauses,
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

export function buildSeriesFromPrediction(
  prediction: PredictionResult | null | undefined,
  metric: ChartMetricId,
  xMode: AxisMode,
  routePoints?: RouteChartPoint[] | null,
  routeSource?: 'gpx' | 'brouter',
  startTime?: string | null,
  itinerary?: Itinerary,
): ChartPoint[] | null {
  const pauseSchedule = xMode === 'distance' || !itinerary
    ? null
    : buildPauseAwareSchedule(itinerary, prediction);

  if (isRouteBackedMetric(metric)) {
    const routeSeries = buildSeriesFromRouteProfile(
      routePoints,
      prediction,
      metric,
      xMode,
      routeSource,
      startTime,
      pauseSchedule,
    );
    if (routeSeries) return routeSeries;
  }

  if (!prediction || prediction.points.length === 0) return null;
  if (!metricIsAvailable(metric)) return null;

  const predictionCache = getPredictionSeriesCacheMap(prediction);
  const predictionCacheKey = getPredictionSeriesCacheKey(metric, xMode, startTime, pauseSchedule?.pauseSignature);
  const cached = predictionCache.get(predictionCacheKey);
  if (cached !== undefined) return cached;

  let result: ChartPoint[] | null = null;

  if (metric === 'Vitesse moyenne' || metric === 'Puissance moyenne') {
    const averageSeries = buildFixedDistanceAverageSeries(
      prediction,
      metric,
      xMode,
      startTime,
      xMode === 'distance'
        ? undefined
        : (elapsedHours) => projectPredictionElapsedHoursToX(elapsedHours, xMode, startTime, pauseSchedule),
    );
    if (averageSeries) {
      result = xMode === 'distance'
        ? averageSeries
        : insertPauseSegments(averageSeries, pauseSchedule?.pauseSpans ?? [], xMode, startTime, () => 0);
      predictionCache.set(predictionCacheKey, result);
      return result;
    }
  }

  const points: ChartPoint[] = [];
  for (const point of prediction.points) {
    const x =
      xMode === 'distance'
        ? point.distance_m / 1000
        : projectPredictionElapsedHoursToX(point.elapsed_time_s / 3600, xMode, startTime, pauseSchedule);
    const y = metricValueAtPoint(metric, point);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x, y });
    }
  }

  const pointsWithPauses = xMode === 'distance'
    ? points
    : insertPauseSegments(
        points,
        pauseSchedule?.pauseSpans ?? [],
        xMode,
        startTime,
        () => (isPauseZeroMetric(metric) ? 0 : null),
      );

  result = pointsWithPauses.length > 1 ? fitChartPointBudget(pointsWithPauses) : null;
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

export function computeDomain(series: ChartPoint[][]): AxisDomain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const arr of series) {
    for (const point of arr) {
      if (point.y < min) min = point.y;
      if (point.y > max) max = point.y;
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
  if (min >= 0 && lo < 0) lo = 0;
  return { min: lo, max: hi };
}

export function computeXDomain(series: ChartPoint[][], xMode: AxisMode): AxisDomain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const arr of series) {
    for (const point of arr) {
      if (point.x < min) min = point.x;
      if (point.x > max) max = point.x;
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