import type { PredictionResult } from '@/features/fitPredictor';
import type { AxisMode, ChartMetricId, ChartPoint, RouteChartPoint } from '../seriesCommon';

const predictionSeriesCache = new WeakMap<PredictionResult, Map<string, ChartPoint[] | null>>();
const routeBackedSeriesCache = new WeakMap<RouteChartPoint[], RouteBackedSeriesCacheBucket>();

interface RouteBackedSeriesCacheBucket {
  withoutPrediction: Map<string, ChartPoint[] | null>;
  withPrediction: WeakMap<PredictionResult, Map<string, ChartPoint[] | null>>;
}

export function getPredictionSeriesCacheMap(
  prediction: PredictionResult,
): Map<string, ChartPoint[] | null> {
  let cache = predictionSeriesCache.get(prediction);
  if (!cache) {
    cache = new Map<string, ChartPoint[] | null>();
    predictionSeriesCache.set(prediction, cache);
  }
  return cache;
}

export function getRouteBackedSeriesCacheMap(
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

export function getRouteBackedSeriesCacheKey(
  metric: ChartMetricId,
  xMode: AxisMode,
  routeSource?: 'gpx' | 'brouter',
  startTime?: string | null,
  pauseSignature?: string,
  routeSignature?: string,
): string {
  return [
    metric,
    xMode,
    routeSource ?? '',
    xMode === 'heure' ? startTime ?? '' : '',
    pauseSignature ?? '',
    routeSignature ?? '',
  ].join('|');
}

export function getPredictionSeriesCacheKey(
  metric: ChartMetricId,
  xMode: AxisMode,
  startTime?: string | null,
  pauseSignature?: string,
): string {
  return [metric, xMode, xMode === 'heure' ? startTime ?? '' : '', pauseSignature ?? ''].join('|');
}