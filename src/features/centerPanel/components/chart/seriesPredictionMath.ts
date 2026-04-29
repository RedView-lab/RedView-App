import type { PredictionPoint, PredictionResult } from '@/features/fitPredictor';
import type { AxisMode, ChartMetricId, ChartPoint } from './seriesCommon';

const INTERVAL_AVERAGE_SPAN_M = 500;
const MAX_CHART_POINT_COUNT = 2_048;

interface DistanceMetricSample {
  distanceM: number;
  elapsedHours: number;
  value: number;
}

export function metricValueAtPoint(metric: ChartMetricId, point: PredictionPoint): number {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
      return point.predicted_speed_kmh;
    case 'Puissance':
    case 'Puissance moyenne':
      return point.predicted_power_w;
    case 'Altitude':
      return point.elevation_m;
    case 'Inclinaison (%)':
      return point.gradient_pct;
    case 'Inclinaison (°)':
      return gradientPercentToDegrees(point.gradient_pct);
    default:
      return Number.NaN;
  }
}

export function fitChartPointBudget(
  points: ChartPoint[],
  maxPoints = MAX_CHART_POINT_COUNT,
): ChartPoint[] {
  if (points.length <= maxPoints) return points;

  const first = points[0];
  const last = points[points.length - 1];
  const span = last.x - first.x;
  if (span <= 0) return [first, last];

  const bucketCount = Math.max(8, Math.floor(maxPoints / 2));
  const buckets: ChartPoint[][] = Array.from({ length: bucketCount }, () => []);
  for (const point of points) {
    const ratio = (point.x - first.x) / span;
    const bucketIndex = Math.max(0, Math.min(bucketCount - 1, Math.floor(ratio * bucketCount)));
    buckets[bucketIndex]?.push(point);
  }

  const reduced: ChartPoint[] = [];
  const pushPoint = (point: ChartPoint) => {
    const previous = reduced[reduced.length - 1];
    if (
      previous &&
      Math.abs(previous.x - point.x) < 1e-6 &&
      Math.abs(previous.y - point.y) < 1e-6
    ) {
      return;
    }
    reduced.push(point);
  };

  for (const bucket of buckets) {
    if (bucket.length === 0) continue;

    let minPoint = bucket[0];
    let maxPoint = bucket[0];
    for (const point of bucket) {
      if (point.y < minPoint.y) minPoint = point;
      if (point.y > maxPoint.y) maxPoint = point;
    }

    const ordered = [bucket[0], minPoint, maxPoint, bucket[bucket.length - 1]]
      .filter((point, index, arr) => arr.indexOf(point) === index)
      .sort((left, right) => left.x - right.x);

    for (const point of ordered) pushPoint(point);
  }

  return reduced.length >= 2 ? reduced : [first, last];
}

export function buildFixedDistanceAverageSeries(
  prediction: PredictionResult,
  metric: ChartMetricId,
  xMode: AxisMode,
  startTime?: string | null,
): ChartPoint[] | null {
  const samples = buildDistanceMetricSamples(prediction, metric);
  if (samples.length < 2) return null;

  const firstDistanceM = samples[0].distanceM;
  const lastDistanceM = samples[samples.length - 1].distanceM;
  if (lastDistanceM <= firstDistanceM) return null;

  const result: ChartPoint[] = [];
  let startDistanceM = Math.max(
    0,
    Math.floor(firstDistanceM / INTERVAL_AVERAGE_SPAN_M) * INTERVAL_AVERAGE_SPAN_M,
  );

  while (startDistanceM < lastDistanceM - 1e-6) {
    const endDistanceM = Math.min(lastDistanceM, startDistanceM + INTERVAL_AVERAGE_SPAN_M);
    const avg = averageDistanceMetricOverInterval(samples, startDistanceM, endDistanceM);
    const startX =
      xMode === 'distance'
        ? startDistanceM / 1000
        : projectElapsedHoursToX(
            interpolateElapsedHoursAtDistance(samples, startDistanceM),
            xMode,
            startTime,
          );
    const endX =
      xMode === 'distance'
        ? endDistanceM / 1000
        : projectElapsedHoursToX(
            interpolateElapsedHoursAtDistance(samples, endDistanceM),
            xMode,
            startTime,
          );

    if (Number.isFinite(avg) && Number.isFinite(startX) && Number.isFinite(endX) && endX > startX) {
      if (result.length === 0) {
        result.push({ x: startX, y: avg });
      } else {
        const prev = result[result.length - 1];
        if (Math.abs(prev.x - startX) > 1e-6) {
          result.push({ x: startX, y: prev.y });
        }
        if (Math.abs(prev.y - avg) > 1e-6) {
          result.push({ x: startX, y: avg });
        }
      }

      result.push({ x: endX, y: avg });
    }

    startDistanceM = endDistanceM;
  }

  return result.length > 1 ? fitChartPointBudget(result) : null;
}

export function projectElapsedHoursToX(
  elapsedHours: number | null,
  xMode: AxisMode,
  startTime?: string | null,
): number {
  if (!Number.isFinite(elapsedHours)) return Number.NaN;
  if (xMode !== 'heure') return elapsedHours as number;
  return (elapsedHours as number) + parseStartTimeHours(startTime);
}

export function parseStartTimeHours(startTime?: string | null): number {
  if (!startTime) return 0;
  const [hoursRaw, minutesRaw] = startTime.split(':');
  const hours = Number.parseInt(hoursRaw ?? '', 10);
  const minutes = Number.parseInt(minutesRaw ?? '', 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours + minutes / 60;
}

function gradientPercentToDegrees(gradientPercent: number): number {
  return (Math.atan(gradientPercent / 100) * 180) / Math.PI;
}

export { gradientPercentToDegrees };

function buildDistanceMetricSamples(
  prediction: PredictionResult,
  metric: ChartMetricId,
): DistanceMetricSample[] {
  const samples = prediction.points
    .map((point) => ({
      distanceM: point.distance_m,
      elapsedHours: point.elapsed_time_s / 3600,
      value: metricValueAtPoint(metric, point),
    }))
    .filter(
      (sample) =>
        Number.isFinite(sample.distanceM) &&
        Number.isFinite(sample.elapsedHours) &&
        Number.isFinite(sample.value),
    )
    .sort((left, right) => left.distanceM - right.distanceM);

  const deduped: DistanceMetricSample[] = [];
  for (const sample of samples) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.distanceM - sample.distanceM) < 1e-6) {
      deduped[deduped.length - 1] = sample;
      continue;
    }
    deduped.push(sample);
  }

  return deduped;
}

function interpolateDistanceMetricValue(
  samples: DistanceMetricSample[],
  distanceM: number,
): number {
  if (samples.length === 0) return Number.NaN;
  if (distanceM <= samples[0].distanceM) return samples[0].value;
  if (distanceM >= samples[samples.length - 1].distanceM) {
    return samples[samples.length - 1].value;
  }

  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = samples[lo];
  const end = samples[hi];
  const spanM = end.distanceM - start.distanceM;
  if (spanM <= 0) return start.value;
  const ratio = (distanceM - start.distanceM) / spanM;
  return start.value + (end.value - start.value) * ratio;
}

function interpolateElapsedHoursAtDistance(
  samples: DistanceMetricSample[],
  distanceM: number,
): number {
  if (samples.length === 0) return Number.NaN;
  if (distanceM <= samples[0].distanceM) return samples[0].elapsedHours;
  if (distanceM >= samples[samples.length - 1].distanceM) {
    return samples[samples.length - 1].elapsedHours;
  }

  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = samples[lo];
  const end = samples[hi];
  const spanM = end.distanceM - start.distanceM;
  if (spanM <= 0) return start.elapsedHours;
  const ratio = (distanceM - start.distanceM) / spanM;
  return start.elapsedHours + (end.elapsedHours - start.elapsedHours) * ratio;
}

function averageDistanceMetricOverInterval(
  samples: DistanceMetricSample[],
  startDistanceM: number,
  endDistanceM: number,
): number {
  const spanM = endDistanceM - startDistanceM;
  if (spanM <= 0) return Number.NaN;

  const breakpoints = [startDistanceM];
  for (const sample of samples) {
    if (sample.distanceM > startDistanceM && sample.distanceM < endDistanceM) {
      breakpoints.push(sample.distanceM);
    }
  }
  breakpoints.push(endDistanceM);

  let integral = 0;
  let prevDistanceM = breakpoints[0] ?? startDistanceM;
  let prevValue = interpolateDistanceMetricValue(samples, prevDistanceM);
  for (let index = 1; index < breakpoints.length; index += 1) {
    const currentDistanceM = breakpoints[index] ?? prevDistanceM;
    const currentValue = interpolateDistanceMetricValue(samples, currentDistanceM);
    integral += ((prevValue + currentValue) / 2) * (currentDistanceM - prevDistanceM);
    prevDistanceM = currentDistanceM;
    prevValue = currentValue;
  }

  return integral / spanM;
}