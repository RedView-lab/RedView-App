import type { PredictionResult } from '@/features/fitPredictor';
import { buildScheduledTimelineState, distanceAtElapsedSeconds, parseStartReference } from '../../sections/timeline/TimelineTimelineView/utils';
import type { TimelineStopAnchor } from '../../sections/timeline/TimelineTimelineView/types';
import type { Itinerary } from '../../types';

export interface PauseAwarePauseSpan {
  distanceM: number;
  durationSeconds: number;
  startRideSeconds: number;
  startScheduledSeconds: number;
  endScheduledSeconds: number;
}

export interface PauseAwareSchedule {
  stopAnchors: TimelineStopAnchor[];
  pauseSpans: PauseAwarePauseSpan[];
  totalDurationSeconds: number;
  pauseSignature: string;
}

export function buildPauseAwareSchedule(
  itinerary: Itinerary,
  prediction: PredictionResult | null | undefined,
): PauseAwareSchedule | null {
  if (!prediction || prediction.points.length < 2) return null;

  const reference = parseStartReference(itinerary.rhythm);
  const state = buildScheduledTimelineState(
    itinerary.timeline,
    prediction,
    reference,
    itinerary.rhythm,
  );

  const stopAnchors = state.stopAnchors
    .filter((anchor) => anchor.durationMin > 0)
    .sort((left, right) => left.rideElapsedSeconds - right.rideElapsedSeconds);

  const pauseSpans = stopAnchors
    .map((anchor) => {
      const durationSeconds = anchor.durationMin * 60;
      const distanceM = distanceAtElapsedSeconds(prediction, anchor.rideElapsedSeconds);
      return {
        distanceM: Number.isFinite(distanceM) ? (distanceM as number) : Number.NaN,
        durationSeconds,
        startRideSeconds: anchor.rideElapsedSeconds,
        startScheduledSeconds: anchor.scheduledElapsedSeconds,
        endScheduledSeconds: anchor.scheduledElapsedSeconds + durationSeconds,
      };
    })
    .filter((span) => Number.isFinite(span.distanceM) && span.durationSeconds > 0);

  const lastRideSeconds = Math.max(
    prediction.total_time_s ?? 0,
    prediction.points[prediction.points.length - 1]?.elapsed_time_s ?? 0,
  );

  return {
    stopAnchors,
    pauseSpans,
    totalDurationSeconds: projectRideElapsedSecondsToScheduledSeconds(lastRideSeconds, stopAnchors),
    pauseSignature: stopAnchors
      .map((anchor) => `${anchor.rideElapsedSeconds}:${anchor.durationMin}`)
      .join('|'),
  };
}

export function projectRideElapsedSecondsToScheduledSeconds(
  rideElapsedSeconds: number,
  stopAnchors: ReadonlyArray<Pick<TimelineStopAnchor, 'rideElapsedSeconds' | 'durationMin'>>,
): number {
  let scheduledElapsedSeconds = rideElapsedSeconds;
  for (const anchor of stopAnchors) {
    if (rideElapsedSeconds <= anchor.rideElapsedSeconds) break;
    scheduledElapsedSeconds += anchor.durationMin * 60;
  }
  return scheduledElapsedSeconds;
}