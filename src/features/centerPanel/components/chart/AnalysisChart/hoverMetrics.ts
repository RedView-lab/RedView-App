import type { PredictionResult } from '@/features/fitPredictor';
import {
  buildPauseAwareSchedule,
  projectRideElapsedSecondsToScheduledSeconds,
} from '@/features/itineraryPanel/lib/schedule';
import type { AxisMode, ChartPoint, RouteChartPoint } from '../series';
import { projectXToDistanceM } from '../series/builders';
import {
  getPredictionTimeline,
  interpolateElapsedHoursFromTimeline,
} from '../series/timeline';
import { computeCumulativeElevationAtX } from './math';
import type { ChartItineraryNode } from './types';

export interface ItineraryHoverResolvedMetrics {
  distanceFormatted: string;
  gainM: number;
  lossM: number;
  durationFormatted: string;
  timeFormatted: string;
}

export function resolveItineraryHoverMetrics({
  hoverXValue,
  xMode,
  node,
  profilePoints,
}: {
  hoverXValue: number;
  xMode: AxisMode;
  node?: ChartItineraryNode | null;
  profilePoints?: ChartPoint[] | null;
}): ItineraryHoverResolvedMetrics {
  const startTime = node?.itinerary.rhythm?.startTime?.trim() || '08:00';
  const timeMatch = /^(\d{1,2}):(\d{2})$/u.exec(startTime);
  const startH = timeMatch ? Number.parseInt(timeMatch[1], 10) : 8;
  const startM = timeMatch ? Number.parseInt(timeMatch[2], 10) : 0;
  const startTimeHours = startH + startM / 60;
  const startSecOfDay = startH * 3600 + startM * 60;

  const pred = node?.prediction as PredictionResult | null | undefined;
  const pauseSchedule = node?.itinerary
    ? buildPauseAwareSchedule(node.itinerary, pred)
    : null;

  // 1. Distance en km avec 2 décimales (ex: 127.23 km ou 3.80 km)
  let displayDistanceKm = 0;
  let targetDistanceM = 0;

  if (xMode === 'distance') {
    displayDistanceKm = hoverXValue;
    targetDistanceM = Math.max(0, (hoverXValue - (node?.xOffset ?? 0)) * 1000);
  } else {
    const routePoints = (node?.itinerary.gpxRoute?.points ?? []) as RouteChartPoint[];
    targetDistanceM = projectXToDistanceM(
      routePoints,
      pred,
      xMode,
      hoverXValue,
      startTime,
      pauseSchedule,
    );
    displayDistanceKm = Number.isFinite(targetDistanceM) ? targetDistanceM / 1000 : 0;
  }

  const distanceFormatted = `${displayDistanceKm.toFixed(2)} km`;

  // 2. Dénivelé positif (D+) et dénivelé négatif (D-) cumulés
  const elevationPoints = node?.altitudeShiftedPoints ?? profilePoints ?? [];
  const { gainM, lossM } = computeCumulativeElevationAtX(elevationPoints, hoverXValue);

  // 3. Durée et heure d'arrivée/passage au point
  let scheduledSeconds: number | null = null;

  if (xMode === 'temps') {
    scheduledSeconds = Math.max(0, hoverXValue * 3600);
  } else if (xMode === 'heure') {
    scheduledSeconds = Math.max(0, (hoverXValue - startTimeHours) * 3600);
  } else {
    // Mode distance : projection via timeline et programme de pauses
    if (pred && pred.points && pred.points.length >= 2) {
      const timeline = getPredictionTimeline(pred);
      const rideElapsedHours = interpolateElapsedHoursFromTimeline(timeline, targetDistanceM);
      if (rideElapsedHours != null) {
        const rideElapsedSeconds = rideElapsedHours * 3600;
        scheduledSeconds = pauseSchedule
          ? projectRideElapsedSecondsToScheduledSeconds(rideElapsedSeconds, pauseSchedule.stopAnchors)
          : rideElapsedSeconds;
      }
    }

    if (scheduledSeconds == null) {
      const points = node?.itinerary.gpxRoute?.points;
      const lastPoint = points && points.length > 0 ? points[points.length - 1] : null;
      const totalDistM =
        (node?.itinerary.metrics?.distanceKm ?? (lastPoint?.distanceM ?? 0) / 1000) * 1000;
      const totalSec =
        pauseSchedule?.totalDurationSeconds ??
        node?.itinerary.metrics?.durationSec ??
        (totalDistM > 0 ? (totalDistM / 1000 / 20) * 3600 : 0);
      const fraction = totalDistM > 0 ? Math.min(1, Math.max(0, targetDistanceM / totalDistM)) : 0;
      scheduledSeconds = fraction * totalSec;
    }
  }

  // Format durée : 02 : 48 : 59 (Figma node 1894:40701)
  const totalSec = Math.max(0, Math.round(scheduledSeconds));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const durationFormatted = `${String(h).padStart(2, '0')} : ${String(m).padStart(2, '0')} : ${String(s).padStart(2, '0')}`;

  // Format jour et heure : J1 - 08:29 (Figma node 1894:40702)
  const currentSecFromStartOfDay = startSecOfDay + scheduledSeconds;
  const dayNumber = Math.max(1, Math.floor(currentSecFromStartOfDay / 86400) + 1);
  const secInDay = ((Math.round(currentSecFromStartOfDay) % 86400) + 86400) % 86400;
  const clockH = Math.floor(secInDay / 3600);
  const clockM = Math.floor((secInDay % 3600) / 60);
  const timeFormatted = `J${dayNumber} - ${String(clockH).padStart(2, '0')}:${String(clockM).padStart(2, '0')}`;

  return {
    distanceFormatted,
    gainM,
    lossM,
    durationFormatted,
    timeFormatted,
  };
}
