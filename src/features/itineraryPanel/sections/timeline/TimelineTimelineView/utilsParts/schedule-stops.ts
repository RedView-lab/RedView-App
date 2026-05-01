import type { PredictionResult } from '@/features/fitPredictor';
import type { RhythmState, TimelineItem } from '../../../../types';
import type { StartReference, TimedIntervalPause, TimelineStopAnchor } from '../types';

export function distanceAtElapsedSeconds(
  prediction: PredictionResult | null | undefined,
  elapsedSeconds: number,
): number | null {
  const points = prediction?.points ?? [];
  if (points.length < 2) return null;
  if (elapsedSeconds <= points[0]!.elapsed_time_s) return points[0]!.distance_m;

  const last = points[points.length - 1]!;
  if (elapsedSeconds >= last.elapsed_time_s) return last.distance_m;

  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid]!.elapsed_time_s <= elapsedSeconds) lo = mid;
    else hi = mid;
  }

  const start = points[lo]!;
  const end = points[hi]!;
  const span = end.elapsed_time_s - start.elapsed_time_s;
  if (span <= 0) return start.distance_m;
  const t = (elapsedSeconds - start.elapsed_time_s) / span;
  return start.distance_m + (end.distance_m - start.distance_m) * t;
}

export function resolveRideElapsedSecondsAtScheduledElapsed(
  scheduledElapsedSeconds: number,
  stopAnchors: TimelineStopAnchor[],
): number {
  let cumulativeStopMinutes = 0;

  stopAnchors.forEach((anchor) => {
    const anchorScheduledSeconds = anchor.rideElapsedSeconds + cumulativeStopMinutes * 60;
    if (scheduledElapsedSeconds <= anchorScheduledSeconds) return;
    cumulativeStopMinutes += anchor.durationMin;
  });

  return Math.max(0, scheduledElapsedSeconds - cumulativeStopMinutes * 60);
}

export function applyStopAnchorsToRideElapsedSeconds(
  rideElapsedSeconds: number,
  stopAnchors: TimelineStopAnchor[],
): number {
  return stopAnchors.reduce(
    (elapsedSeconds, anchor) => (
      anchor.rideElapsedSeconds < rideElapsedSeconds
        ? elapsedSeconds + anchor.durationMin * 60
        : elapsedSeconds
    ),
    rideElapsedSeconds,
  );
}

export function resolveFavoritePoiPauseDurationMin(
  item: TimelineItem,
  rhythm?: RhythmState,
): number {
  if (!rhythm?.pauseAtFavoritePois) return 0;
  if (item.visible === false || item.kind !== 'poi' || !item.favorite || !item.poiCategory) return 0;

  const durationMin = rhythm.poiPauseDurations[item.poiCategory];
  if (
    durationMin === null
    || durationMin === undefined
    || !Number.isFinite(durationMin)
    || durationMin <= 0
  ) {
    return 0;
  }

  return durationMin;
}

export function resolveTimelineStopDurationMin(item: TimelineItem, rhythm?: RhythmState): number {
  if (item.visible === false) return 0;
  if (item.kind === 'pause') return Math.max(0, item.durationMin ?? 0);
  return resolveFavoritePoiPauseDurationMin(item, rhythm);
}

export function buildTimedIntervalPauses(
  prediction: PredictionResult | null | undefined,
  reference: StartReference,
  rhythm: RhythmState | undefined,
  totalDistanceM: number,
): TimedIntervalPause[] {
  if (!rhythm?.pauseEveryIntervalEnabled || !prediction || prediction.points.length < 2) {
    return [];
  }

  const pauses: TimedIntervalPause[] = [];
  let sortIndex = 10_000;

  rhythm.pauseIntervals.forEach((intervalRow) => {
    const stopTimes = buildIntervalStopTimes(intervalRow.intervalMin, prediction.riding_time_s);
    stopTimes.forEach((rideElapsedSeconds, index) => {
      const distanceM = distanceAtElapsedSeconds(prediction, rideElapsedSeconds);
      if (!Number.isFinite(distanceM)) return;

      pauses.push({
        id: `${intervalRow.id}::${index}`,
        label: `${intervalRow.label} ${index + 1}`,
        sortIndex,
        distanceKm: Math.max(0, Math.min(totalDistanceM, distanceM as number)) / 1000,
        durationMin: Math.max(0, intervalRow.durationMin),
        visible: true,
        rideElapsedSeconds,
        elapsedSeconds: rideElapsedSeconds,
        minuteOfDay: reference.startMinutes + rideElapsedSeconds / 60,
        date: reference.reference
          ? new Date(reference.reference.getTime() + rideElapsedSeconds * 1000)
          : null,
        dayKey: null,
      });
      sortIndex += 1;
    });
  });

  return pauses;
}

function buildIntervalStopTimes(intervalMin: number, totalRideSeconds: number): number[] {
  const intervalSeconds = Math.max(0, intervalMin) * 60;
  if (intervalSeconds <= 0) return [];

  const stops: number[] = [];
  for (
    let elapsedSeconds = intervalSeconds;
    elapsedSeconds < totalRideSeconds;
    elapsedSeconds += intervalSeconds
  ) {
    stops.push(elapsedSeconds);
  }
  return stops;
}