import type { PredictionResult } from '@/features/fitPredictor';
import type { AxisMode } from '../components/chart';
import { projectRideElapsedSecondsToScheduledSeconds, type PauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import { clampDistanceM, elapsedSecondsAtDistance } from '@/features/itineraryPanel/lib/schedule/predictionElapsed';

/**
 * Projection distance → abscisse du graphique d'analyse (distance, temps de
 * roulage, heure) partagée par le flyover, le survol de la trace, la timeline
 * et la synchro POI.
 */

function parseStartTimeHours(startTime?: string | null): number {
  if (!startTime) return 0;
  const [hoursRaw, minutesRaw] = startTime.split(':');
  const hours = Number.parseInt(hoursRaw ?? '', 10);
  const minutes = Number.parseInt(minutesRaw ?? '', 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours + minutes / 60;
}

export function xValueFromDistance(
  distanceM: number,
  options: {
    prediction: PredictionResult | null | undefined;
    totalDistanceM: number;
    xMode: AxisMode;
    startTime?: string | null;
    pauseSchedule?: PauseAwareSchedule | null;
  },
): number {
  const clampedDistanceM = clampDistanceM(distanceM, options.totalDistanceM);
  if (options.xMode === 'distance') return clampedDistanceM / 1000;

  const elapsedSeconds = elapsedSecondsAtDistance(
    options.prediction,
    clampedDistanceM,
    options.totalDistanceM,
  );
  if (!Number.isFinite(elapsedSeconds)) return Number.NaN;

  const scheduledElapsedSeconds = options.pauseSchedule
    ? projectRideElapsedSecondsToScheduledSeconds(elapsedSeconds as number, options.pauseSchedule.stopAnchors)
    : (elapsedSeconds as number);

  const elapsedHours = scheduledElapsedSeconds / 3600;
  if (options.xMode === 'heure') return elapsedHours + parseStartTimeHours(options.startTime);
  return elapsedHours;
}

export function formatDistanceLabel(distanceM: number): string {
  return `${(distanceM / 1000).toFixed(1)} km`;
}

export function formatPlaybackClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }
  return [minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}
