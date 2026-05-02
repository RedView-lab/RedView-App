import type { PredictionResult } from '@/features/fitPredictor';
import { projectRideElapsedSecondsToScheduledSeconds, type PauseAwarePauseSpan, type PauseAwareSchedule } from '@/features/itineraryPanel/lib/pauseAwareSchedule';
import type { AxisMode, ChartMetricId, ChartPoint } from '../seriesCommon';
import { projectElapsedHoursToX } from '../seriesPredictionMath';

export interface TimelineSample {
  distanceM: number;
  elapsedHours: number;
}

const predictionTimelineCache = new WeakMap<PredictionResult, TimelineSample[] | null>();

export function getPredictionTimeline(
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
    .filter((point) => Number.isFinite(point.distanceM) && Number.isFinite(point.elapsedHours));

  const result = timeline.length >= 2 ? timeline : null;
  predictionTimelineCache.set(prediction, result);
  return result;
}

export function interpolateElapsedHoursFromTimeline(
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

export function interpolateDistanceMFromElapsedHours(
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

export function projectPredictionElapsedHoursToX(
  elapsedHours: number | null,
  xMode: AxisMode,
  startTime: string | null | undefined,
  pauseSchedule?: PauseAwareSchedule | null,
): number {
  if (!Number.isFinite(elapsedHours)) return Number.NaN;
  const rideElapsedSeconds = (elapsedHours as number) * 3600;
  const scheduledElapsedSeconds = pauseSchedule
    ? projectRideElapsedSecondsToScheduledSeconds(rideElapsedSeconds, pauseSchedule.stopAnchors)
    : rideElapsedSeconds;
  return projectElapsedHoursToX(scheduledElapsedSeconds / 3600, xMode, startTime);
}

export function isPauseZeroMetric(metric: ChartMetricId): boolean {
  return metric === 'Vitesse'
    || metric === 'Vitesse moyenne'
    || metric === 'Puissance'
    || metric === 'Puissance moyenne';
}

export function insertPauseSegments(
  points: ChartPoint[],
  pauseSpans: PauseAwarePauseSpan[],
  xMode: AxisMode,
  startTime: string | null | undefined,
  resolvePauseY: (args: { beforeY: number; afterY: number }) => number | null,
): ChartPoint[] {
  if (points.length < 2 || pauseSpans.length === 0) return points;

  const projectedPauseSpans = pauseSpans
    .map((span) => ({
      startX: projectElapsedHoursToX(span.startScheduledSeconds / 3600, xMode, startTime),
      endX: projectElapsedHoursToX(span.endScheduledSeconds / 3600, xMode, startTime),
    }))
    .filter((span) => Number.isFinite(span.startX) && Number.isFinite(span.endX) && span.endX > span.startX)
    .sort((left, right) => left.startX - right.startX);

  if (projectedPauseSpans.length === 0) return points;

  const result: ChartPoint[] = [];
  let pointIndex = 0;

  for (const span of projectedPauseSpans) {
    while (pointIndex < points.length && points[pointIndex]!.x < span.startX) {
      pushUniqueChartPoint(result, points[pointIndex]!);
      pointIndex += 1;
    }

    const beforeY = interpolateYAtX(points, span.startX);
    const afterY = interpolateYAtX(points, span.endX);
    if (!Number.isFinite(beforeY) || !Number.isFinite(afterY)) continue;

    const pauseY = resolvePauseY({ beforeY, afterY });
    if (pauseY === null) {
      pushUniqueChartPoint(result, { x: span.startX, y: beforeY });
      pushUniqueChartPoint(result, { x: span.endX, y: beforeY });
      pushUniqueChartPoint(result, { x: span.endX, y: afterY });
    } else {
      pushUniqueChartPoint(result, { x: span.startX, y: beforeY });
      pushUniqueChartPoint(result, { x: span.startX, y: pauseY });
      pushUniqueChartPoint(result, { x: span.endX, y: pauseY });
      pushUniqueChartPoint(result, { x: span.endX, y: afterY });
    }

    while (pointIndex < points.length && points[pointIndex]!.x <= span.endX) {
      pointIndex += 1;
    }
  }

  while (pointIndex < points.length) {
    pushUniqueChartPoint(result, points[pointIndex]!);
    pointIndex += 1;
  }

  return result.length > 1 ? result : points;
}

function interpolateYAtX(points: ChartPoint[], x: number): number {
  if (points.length === 0) return Number.NaN;
  if (x <= points[0]!.x) return points[0]!.y;
  if (x >= points[points.length - 1]!.x) return points[points.length - 1]!.y;

  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid]!.x <= x) lo = mid;
    else hi = mid;
  }

  const start = points[lo]!;
  const end = points[hi]!;
  const span = end.x - start.x;
  if (span <= 0) return start.y;
  const t = (x - start.x) / span;
  return start.y + (end.y - start.y) * t;
}

function pushUniqueChartPoint(points: ChartPoint[], nextPoint: ChartPoint): void {
  const previous = points[points.length - 1];
  if (
    previous
    && Math.abs(previous.x - nextPoint.x) < 1e-6
    && Math.abs(previous.y - nextPoint.y) < 1e-6
  ) {
    return;
  }
  points.push(nextPoint);
}