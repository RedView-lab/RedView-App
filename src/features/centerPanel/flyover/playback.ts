import type { PredictionResult } from '@/features/fitPredictor';
import type { AxisMode } from '../components/chart';
import { projectRideElapsedSecondsToScheduledSeconds, type PauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';

/**
 * Projection distance → abscisse du graphique d'analyse (distance, temps de
 * roulage, heure) partagée par le flyover, le survol de la trace, la timeline
 * et la synchro POI.
 */

function clampDistanceM(distanceM: number, totalDistanceM: number): number {
  if (!Number.isFinite(distanceM)) return 0;
  return Math.max(0, Math.min(totalDistanceM, distanceM));
}

export function elapsedSecondsAtDistance(
  prediction: PredictionResult | null | undefined,
  distanceM: number,
  totalDistanceM: number,
): number | null {
  const points = prediction?.points ?? [];
  if (points.length >= 2) {
    if (distanceM <= points[0].distance_m) return points[0].elapsed_time_s;
    const lastPoint = points[points.length - 1];
    if (distanceM >= lastPoint.distance_m) return lastPoint.elapsed_time_s;

    let lo = 0;
    let hi = points.length - 1;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (points[mid].distance_m <= distanceM) lo = mid;
      else hi = mid;
    }

    const start = points[lo];
    const end = points[hi];
    const span = end.distance_m - start.distance_m;
    if (span <= 0) return start.elapsed_time_s;
    const t = (distanceM - start.distance_m) / span;
    return start.elapsed_time_s + (end.elapsed_time_s - start.elapsed_time_s) * t;
  }

  const totalTimeS = prediction?.total_time_s ?? null;
  if (!Number.isFinite(totalTimeS) || !Number.isFinite(totalDistanceM) || totalDistanceM <= 0) {
    return null;
  }
  return (clampDistanceM(distanceM, totalDistanceM) / totalDistanceM) * (totalTimeS as number);
}

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
