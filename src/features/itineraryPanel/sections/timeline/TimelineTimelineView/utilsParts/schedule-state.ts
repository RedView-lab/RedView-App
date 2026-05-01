import { elapsedSecondsAtDistance } from '@/features/centerPanel/flyover/playback';
import type { PredictionResult } from '@/features/fitPredictor';
import type { RhythmState, TimelineItem } from '../../../../types';
import type {
  ScheduledTimelineState,
  StartReference,
  TimedTimelineItem,
  TimelineStopAnchor,
} from '../types';
import { getMinuteOfDay, toDayKey } from './format';
import { buildTimedIntervalPauses, resolveTimelineStopDurationMin } from './schedule-stops';

export function resolveTotalDistanceM(
  items: TimelineItem[],
  prediction?: PredictionResult | null,
): number {
  const itemDistanceM = items.reduce(
    (maxDistanceM, item) => Math.max(maxDistanceM, (item.distanceKm ?? 0) * 1000),
    0,
  );
  return Math.max(prediction?.total_distance_m ?? 0, itemDistanceM);
}

export function buildTimedItems(
  items: TimelineItem[],
  prediction: PredictionResult | null | undefined,
  reference: StartReference,
): TimedTimelineItem[] {
  return buildScheduledTimelineState(items, prediction, reference).timedItems;
}

export function buildScheduledTimelineState(
  items: TimelineItem[],
  prediction: PredictionResult | null | undefined,
  reference: StartReference,
  rhythm?: RhythmState,
): ScheduledTimelineState {
  const totalDistanceM = resolveTotalDistanceM(items, prediction);

  const baseItems = items
    .filter((item) => item.distanceKm !== null)
    .map((item, sortIndex) => {
      const distanceKm = item.distanceKm ?? 0;
      const rideElapsedSeconds =
        elapsedSecondsAtDistance(prediction, distanceKm * 1000, totalDistanceM)
        ?? estimateElapsedSeconds(distanceKm);

      return {
        item,
        sortIndex,
        distanceKm,
        rideElapsedSeconds,
      };
    });

  const intervalPauses = buildTimedIntervalPauses(prediction, reference, rhythm, totalDistanceM);
  const scheduledItems = new Map<string, TimedTimelineItem>();
  const scheduledIntervals = new Map<string, ScheduledTimelineState['intervalPauses'][number]>();
  const stopAnchors: TimelineStopAnchor[] = [];
  let cumulativeStopMinutes = 0;

  const entities = [
    ...baseItems.map((entry) => ({
      id: entry.item.id,
      kind: entry.item.kind,
      rideElapsedSeconds: entry.rideElapsedSeconds,
      distanceKm: entry.distanceKm,
      durationMin: resolveTimelineStopDurationMin(entry.item, rhythm),
      sortIndex: entry.sortIndex,
      entry,
      source: 'item' as const,
    })),
    ...intervalPauses.map((entry) => ({
      id: entry.id,
      kind: 'intervalPause' as const,
      rideElapsedSeconds: entry.rideElapsedSeconds,
      distanceKm: entry.distanceKm,
      durationMin: entry.durationMin,
      sortIndex: entry.sortIndex,
      entry,
      source: 'interval' as const,
    })),
  ].sort(
    (left, right) =>
      left.rideElapsedSeconds - right.rideElapsedSeconds
      || left.distanceKm - right.distanceKm
      || rankScheduledEntity(left.kind) - rankScheduledEntity(right.kind)
      || left.sortIndex - right.sortIndex,
  );

  entities.forEach((entity) => {
    const scheduledElapsedSeconds = entity.rideElapsedSeconds + cumulativeStopMinutes * 60;
    const scheduledTiming = resolveScheduledTiming(reference, scheduledElapsedSeconds);

    if (entity.source === 'item') {
      scheduledItems.set(entity.id, {
        item: entity.entry.item,
        sortIndex: entity.entry.sortIndex,
        distanceKm: entity.entry.distanceKm,
        rideElapsedSeconds: entity.entry.rideElapsedSeconds,
        elapsedSeconds: scheduledElapsedSeconds,
        minuteOfDay: scheduledTiming.minuteOfDay,
        date: scheduledTiming.date,
        dayKey: scheduledTiming.dayKey,
      });
    } else {
      scheduledIntervals.set(entity.id, {
        ...entity.entry,
        elapsedSeconds: scheduledElapsedSeconds,
        minuteOfDay: scheduledTiming.minuteOfDay,
        date: scheduledTiming.date,
        dayKey: scheduledTiming.dayKey,
      });
    }

    if (entity.durationMin > 0) {
      stopAnchors.push({
        id: entity.id,
        rideElapsedSeconds: entity.rideElapsedSeconds,
        scheduledElapsedSeconds,
        durationMin: entity.durationMin,
      });
      cumulativeStopMinutes += entity.durationMin;
    }
  });

  return {
    timedItems: baseItems
      .map((entry) => scheduledItems.get(entry.item.id))
      .filter((entry): entry is TimedTimelineItem => Boolean(entry)),
    intervalPauses: intervalPauses
      .map((entry) => scheduledIntervals.get(entry.id))
      .filter((entry): entry is ScheduledTimelineState['intervalPauses'][number] => Boolean(entry)),
    stopAnchors,
  };
}

function estimateElapsedSeconds(distanceKm: number): number {
  const fallbackSpeedKmh = 18;
  return (Math.max(0, distanceKm) / fallbackSpeedKmh) * 3600;
}

function resolveScheduledTiming(
  reference: StartReference,
  scheduledElapsedSeconds: number,
): Pick<TimedTimelineItem, 'minuteOfDay' | 'date' | 'dayKey'> {
  const date = reference.reference
    ? new Date(reference.reference.getTime() + scheduledElapsedSeconds * 1000)
    : null;
  const minuteOfDay = date
    ? getMinuteOfDay(date)
    : reference.startMinutes + scheduledElapsedSeconds / 60;

  return {
    minuteOfDay,
    date,
    dayKey: date && reference.hasRealDate ? toDayKey(date) : null,
  };
}

function rankScheduledEntity(kind: TimelineItem['kind'] | 'intervalPause'): number {
  switch (kind) {
    case 'start':
      return 0;
    case 'waypoint':
      return 1;
    case 'poi':
      return 2;
    case 'pause':
      return 3;
    case 'intervalPause':
      return 4;
    case 'end':
      return 5;
    default:
      return 6;
  }
}