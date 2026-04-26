import { elapsedSecondsAtDistance } from '@/features/centerPanel/flyover/playback';
import type { PredictionResult } from '@/features/fitPredictor/types';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { formatHHmm, getSunTimes } from '@/features/sunlight/lib/sun-calc';

import { buildServiceTagLabel, classifyServices, sampleRouteAtDistance } from './checkpoints';
import { formatDuration, formatMinutesAsDuration, formatScheduleDate, parseStartDateTime, parseTimeReference } from './format';
import type { CheckpointSeed, RouteSample, ScheduledCheckpoint, SegmentMetrics } from './types';

export function buildSchedule(
  itinerary: Itinerary,
  route: RouteSample[],
  checkpoints: CheckpointSeed[],
  prediction: PredictionResult | null,
): ScheduledCheckpoint[] {
  const startReference = buildScheduleReference(itinerary);
  let cumulativeStopMinutes = 0;

  return checkpoints.map((checkpoint, index) => {
    const previous = checkpoints[index - 1] ?? null;
    const metrics = computeSegmentMetrics(route, prediction, previous?.distanceM ?? 0, checkpoint.distanceM);
    const arrivalDate = buildScheduleDate(
      startReference.reference,
      metrics.cumulativeRideSeconds,
      cumulativeStopMinutes,
    );
    const departureDate = buildScheduleDate(
      startReference.reference,
      metrics.cumulativeRideSeconds,
      cumulativeStopMinutes + checkpoint.stopMinutes,
    );
    const { sunriseLabel, sunsetLabel, dayPhase } = describeSunWindow(arrivalDate, checkpoint, startReference.hasRealDate);

    const scheduled: ScheduledCheckpoint = {
      ...checkpoint,
      ...metrics,
      arrivalDate,
      departureDate,
      arrivalLabel: formatScheduleDate(arrivalDate, startReference.reference, startReference.hasRealDate),
      departureLabel: formatScheduleDate(departureDate, startReference.reference, startReference.hasRealDate),
      sunriseLabel,
      sunsetLabel,
      dayPhase,
      cumulativeStopMinutes: cumulativeStopMinutes + checkpoint.stopMinutes,
      serviceFlags: classifyServices(checkpoint),
      serviceTags: buildServiceTagLabel(checkpoint),
    };

    cumulativeStopMinutes += checkpoint.stopMinutes;
    return scheduled;
  });
}

export function buildRoadbookSubtitle(
  itinerary: Itinerary,
  schedule: ScheduledCheckpoint[],
): string {
  const start = buildScheduleStartLabel(itinerary);
  const plannedStops = schedule.reduce((sum, checkpoint) => sum + checkpoint.stopMinutes, 0);
  const finish = schedule[schedule.length - 1]?.departureLabel || schedule[schedule.length - 1]?.arrivalLabel || '--';
  return `Départ: ${start}  |  Arrivée estimée: ${finish}  |  Pauses export: ${formatMinutesAsDuration(plannedStops)}`;
}

export function buildScheduleStartLabel(itinerary: Itinerary): string {
  const reference = buildScheduleReference(itinerary);
  if (!reference.reference) return '--';
  return formatScheduleDate(reference.reference, reference.reference, reference.hasRealDate);
}

function buildScheduleReference(itinerary: Itinerary): {
  reference: Date | null;
  hasRealDate: boolean;
} {
  const { startDate, startTime } = itinerary.rhythm;
  if (startDate && startTime) {
    const parsed = parseStartDateTime(startDate, startTime);
    if (parsed) return { reference: parsed, hasRealDate: true };
  }
  if (startTime) {
    const parsed = parseTimeReference(startTime);
    if (parsed) return { reference: parsed, hasRealDate: false };
  }
  return { reference: null, hasRealDate: false };
}

function buildScheduleDate(
  reference: Date | null,
  rideSeconds: number | null,
  stopMinutes: number,
): Date | null {
  if (!reference || !Number.isFinite(rideSeconds)) return null;
  return new Date(reference.getTime() + ((rideSeconds as number) + stopMinutes * 60) * 1000);
}

function describeSunWindow(
  date: Date | null,
  checkpoint: CheckpointSeed,
  hasRealDate: boolean,
): { sunriseLabel: string; sunsetLabel: string; dayPhase: string } {
  if (!date || !hasRealDate) {
    return { sunriseLabel: '--', sunsetLabel: '--', dayPhase: '--' };
  }
  const sunTimes = getSunTimes(date, checkpoint.lat, checkpoint.lon);
  const sunrise = sunTimes.sunrise;
  const sunset = sunTimes.sunset;
  const dayPhase =
    sunrise && sunset && date >= sunrise && date <= sunset
      ? 'Jour'
      : sunrise && sunset
        ? 'Nuit'
        : '--';
  return {
    sunriseLabel: formatHHmm(sunrise),
    sunsetLabel: formatHHmm(sunset),
    dayPhase,
  };
}

function computeSegmentMetrics(
  route: RouteSample[],
  prediction: PredictionResult | null,
  startDistanceM: number,
  endDistanceM: number,
): SegmentMetrics {
  const clampedStartM = Math.max(0, startDistanceM);
  const clampedEndM = Math.max(clampedStartM, endDistanceM);
  const sectionDistanceM = Math.max(0, clampedEndM - clampedStartM);
  const { ascentM, descentM, netGradientPct } = summarizeElevationBetween(route, clampedStartM, clampedEndM);
  const totalDistanceM = route[route.length - 1]?.distanceM ?? clampedEndM;
  const startElapsedS = elapsedSecondsAtDistance(prediction, clampedStartM, totalDistanceM);
  const endElapsedS = elapsedSecondsAtDistance(prediction, clampedEndM, totalDistanceM);
  const sectionRideSeconds =
    Number.isFinite(startElapsedS) && Number.isFinite(endElapsedS)
      ? Math.max(0, (endElapsedS as number) - (startElapsedS as number))
      : null;
  const cumulativeRideSeconds = Number.isFinite(endElapsedS) ? (endElapsedS as number) : null;
  const avgSpeedKmh =
    Number.isFinite(sectionRideSeconds) && (sectionRideSeconds as number) > 0
      ? (sectionDistanceM / (sectionRideSeconds as number)) * 3.6
      : null;

  return {
    sectionDistanceM,
    ascentM,
    descentM,
    netGradientPct,
    sectionRideSeconds,
    cumulativeRideSeconds,
    avgSpeedKmh,
    avgPowerW: averagePowerBetween(prediction, clampedStartM, clampedEndM),
  };
}

function summarizeElevationBetween(
  route: RouteSample[],
  startDistanceM: number,
  endDistanceM: number,
): Pick<SegmentMetrics, 'ascentM' | 'descentM' | 'netGradientPct'> {
  const start = sampleRouteAtDistance(route, startDistanceM);
  const end = sampleRouteAtDistance(route, endDistanceM);
  const samples: number[] = [];

  if (start.elevationM != null) samples.push(start.elevationM);
  for (const point of route) {
    if (point.distanceM <= startDistanceM || point.distanceM >= endDistanceM) continue;
    if (point.elevationM != null) samples.push(point.elevationM);
  }
  if (end.elevationM != null) samples.push(end.elevationM);

  let ascentM = 0;
  let descentM = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const delta = samples[index]! - samples[index - 1]!;
    if (delta > 0) ascentM += delta;
    if (delta < 0) descentM += Math.abs(delta);
  }

  const netGradientPct =
    endDistanceM > startDistanceM && start.elevationM != null && end.elevationM != null
      ? ((end.elevationM - start.elevationM) / (endDistanceM - startDistanceM)) * 100
      : null;

  return {
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    netGradientPct,
  };
}

function averagePowerBetween(
  prediction: PredictionResult | null,
  startDistanceM: number,
  endDistanceM: number,
): number | null {
  const points = prediction?.points ?? [];
  if (points.length === 0 || endDistanceM <= startDistanceM) return null;

  const matching = points.filter(
    (point) => point.distance_m >= startDistanceM
      && point.distance_m <= endDistanceM
      && Number.isFinite(point.predicted_power_w),
  );
  if (matching.length === 0) return null;

  const total = matching.reduce((sum, point) => sum + point.predicted_power_w, 0);
  return total / matching.length;
}

export function formatRideGapLabel(rideSeconds: number | null | undefined): string {
  return formatDuration(rideSeconds ?? null);
}