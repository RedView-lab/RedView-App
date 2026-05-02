import { elapsedSecondsAtDistance } from '@/features/centerPanel/flyover/playback';
import type { PredictionResult } from '@/features/fitPredictor';
import type { RhythmState, TimelineItem } from '../../../../types';
import type { StartReference, TimedAutoPause, TimedTimelineItem, TimelineStopAnchor } from '../types';

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

export function resolveTimelineStopDurationMin(item: TimelineItem): number {
  if (item.visible === false) return 0;
  if (item.kind === 'pause') return Math.max(0, item.durationMin ?? 0);
  return 0;
}

export function buildTimedAutoPauses(
  baseItems: Array<Pick<TimedTimelineItem, 'item' | 'sortIndex' | 'distanceKm' | 'rideElapsedSeconds'>>,
  prediction: PredictionResult | null | undefined,
  reference: StartReference,
  rhythm: RhythmState | undefined,
  totalDistanceM: number,
): TimedAutoPause[] {
  const pauses: TimedAutoPause[] = [];
  const overrideDistancesKm = rhythm?.pausePositionOverridesKm ?? {};
  let sortIndex = 10_000;

  baseItems.forEach((entry) => {
    const durationMin = resolveFavoritePoiPauseDurationMin(entry.item, rhythm);
    if (durationMin <= 0 || entry.item.kind !== 'poi') return;

    const pauseId = `poi-pause-${entry.item.id}`;
    const distanceKm = resolvePauseDistanceKm(entry.distanceKm, overrideDistancesKm[pauseId], totalDistanceM);
    const rideElapsedSeconds = resolveRideElapsedSecondsForDistance(
      prediction,
      distanceKm,
      totalDistanceM,
      entry.rideElapsedSeconds,
    );

    pauses.push({
      id: pauseId,
      label: `Pause ${entry.item.label}`,
      source: 'favorite-poi',
      attachedToItemId: isSamePauseDistance(distanceKm, entry.distanceKm) ? entry.item.id : null,
      poiCategory: entry.item.poiCategory,
      sortIndex,
      distanceKm,
      durationMin,
      visible: entry.item.visible !== false,
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

  if (!rhythm?.pauseEveryIntervalEnabled || !prediction || prediction.points.length < 2) {
    return pauses;
  }

  rhythm.pauseIntervals.forEach((intervalRow) => {
    const stopTimes = buildIntervalStopTimes(intervalRow.intervalMin, prediction.riding_time_s);
    stopTimes.forEach((rideElapsedSeconds, index) => {
      const distanceM = distanceAtElapsedSeconds(prediction, rideElapsedSeconds);
      if (!Number.isFinite(distanceM)) return;

      const pauseId = `${intervalRow.id}::${index}`;
      const defaultDistanceKm = Math.max(0, Math.min(totalDistanceM, distanceM as number)) / 1000;
      const distanceKm = resolvePauseDistanceKm(defaultDistanceKm, overrideDistancesKm[pauseId], totalDistanceM);
      const resolvedRideElapsedSeconds = resolveRideElapsedSecondsForDistance(
        prediction,
        distanceKm,
        totalDistanceM,
        rideElapsedSeconds,
      );

      pauses.push({
        id: pauseId,
        label: `${intervalRow.label} ${index + 1}`,
        source: 'interval',
        attachedToItemId: null,
        sortIndex,
        distanceKm,
        durationMin: Math.max(0, intervalRow.durationMin),
        visible: true,
        rideElapsedSeconds: resolvedRideElapsedSeconds,
        elapsedSeconds: resolvedRideElapsedSeconds,
        minuteOfDay: reference.startMinutes + resolvedRideElapsedSeconds / 60,
        date: reference.reference
          ? new Date(reference.reference.getTime() + resolvedRideElapsedSeconds * 1000)
          : null,
        dayKey: null,
      });
      sortIndex += 1;
    });
  });

  return pauses;
}

function resolvePauseDistanceKm(
  defaultDistanceKm: number,
  overrideDistanceKm: number | undefined,
  totalDistanceM: number,
): number {
  if (!Number.isFinite(overrideDistanceKm)) {
    return Number(defaultDistanceKm.toFixed(3));
  }

  const maxDistanceKm = Math.max(0, totalDistanceM / 1000);
  return Number(Math.min(maxDistanceKm, Math.max(0, overrideDistanceKm as number)).toFixed(3));
}

function resolveRideElapsedSecondsForDistance(
  prediction: PredictionResult | null | undefined,
  distanceKm: number,
  totalDistanceM: number,
  fallbackRideElapsedSeconds: number,
): number {
  const resolvedRideElapsedSeconds = elapsedSecondsAtDistance(
    prediction,
    distanceKm * 1000,
    totalDistanceM,
  );
  return resolvedRideElapsedSeconds ?? fallbackRideElapsedSeconds;
}

function isSamePauseDistance(leftDistanceKm: number, rightDistanceKm: number): boolean {
  return Math.abs(leftDistanceKm - rightDistanceKm) <= 0.001;
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