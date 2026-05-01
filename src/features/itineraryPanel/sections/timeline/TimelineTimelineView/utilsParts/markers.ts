import { elapsedSecondsAtDistance } from '@/features/centerPanel/flyover/playback';
import type { PredictionResult } from '@/features/fitPredictor';
import type { TimelineItem, TimelineRailConfig } from '../../../../types';
import { DEFAULT_TIMELINE_RAIL } from '../../../../types';
import {
  KM_MARKER_MIN_STEP,
  TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
  TIMELINE_VIEWPORT_TOP_INSET_PX,
} from '../constants';
import type { KmMarker, StartReference, TimelineStopAnchor } from '../types';
import { getMinuteOfDay, toDayKey } from './format';
import { applyStopAnchorsToRideElapsedSeconds, resolveTotalDistanceM } from './schedule-core';

export function resolveMarkerKmStep(
  config?: Partial<TimelineRailConfig>,
  markerStepKm?: number,
): number {
  if (Number.isFinite(markerStepKm) && markerStepKm !== undefined && markerStepKm > 0) {
    return Math.max(50, Math.round(markerStepKm / 5) * 5);
  }
  const kmPerRow = config?.kmPerRow ?? DEFAULT_TIMELINE_RAIL.kmPerRow;
  const rawStep = Math.max(50, KM_MARKER_MIN_STEP, kmPerRow * 5);
  return Math.ceil(rawStep / 5) * 5;
}

export function buildKmMarkers(
  items: TimelineItem[],
  prediction: PredictionResult | null | undefined,
  reference: StartReference,
  displayDayKeySet: ReadonlySet<string>,
  startMinutes: number,
  pixelsPerMinute: number,
  canvasHeight: number,
  kmMarkerStep: number,
  maxDistanceKm: number,
  stopAnchors: TimelineStopAnchor[],
): KmMarker[] {
  const totalDistanceM = resolveTotalDistanceM(items, prediction);
  if (totalDistanceM <= 0) return [];

  const markers: KmMarker[] = [];
  let lastPlacedTopPx = Number.NEGATIVE_INFINITY;

  for (let km = kmMarkerStep; km < maxDistanceKm; km += kmMarkerStep) {
    const rideElapsedSeconds =
      elapsedSecondsAtDistance(prediction, km * 1000, totalDistanceM) ?? estimateElapsedSeconds(km);
    const elapsedSeconds = applyStopAnchorsToRideElapsedSeconds(rideElapsedSeconds, stopAnchors);
    const markerDate = reference.reference
      ? new Date(reference.reference.getTime() + elapsedSeconds * 1000)
      : null;

    if (reference.hasRealDate && markerDate && !displayDayKeySet.has(toDayKey(markerDate))) {
      continue;
    }

    const minuteOfDay = markerDate
      ? getMinuteOfDay(markerDate)
      : reference.startMinutes + elapsedSeconds / 60;
    const rawTopPx =
      (minuteOfDay - startMinutes) * pixelsPerMinute + TIMELINE_VIEWPORT_TOP_INSET_PX;
    const topPx = resolveKmMarkerTopPx(
      rawTopPx,
      pixelsPerMinute,
      lastPlacedTopPx,
      canvasHeight,
    );
    if (topPx < -20 || topPx > canvasHeight + 20) continue;

    lastPlacedTopPx = topPx;
    markers.push({
      id: `km-${km}`,
      label: `km${Math.round(km)}`,
      topPx,
    });
  }

  return markers;
}

function estimateElapsedSeconds(distanceKm: number): number {
  const fallbackSpeedKmh = 18;
  return (Math.max(0, distanceKm) / fallbackSpeedKmh) * 3600;
}

function resolveKmMarkerTopPx(
  rawTopPx: number,
  pixelsPerMinute: number,
  lastPlacedTopPx: number,
  canvasHeight: number,
): number {
  const hourBoundaryClearancePx = 16;
  const hourBoundaryOffsetPx = 18;
  const markerSpacingPx = 18;
  let resolvedTopPx = rawTopPx;

  const relativeMinutes = (rawTopPx - TIMELINE_VIEWPORT_TOP_INSET_PX) / pixelsPerMinute;
  const previousHourBoundaryMinutes = Math.floor(relativeMinutes / 60) * 60;
  const nextHourBoundaryMinutes = previousHourBoundaryMinutes + 60;

  [previousHourBoundaryMinutes, nextHourBoundaryMinutes].forEach((boundaryMinutes) => {
    const boundaryTopPx =
      boundaryMinutes * pixelsPerMinute + TIMELINE_VIEWPORT_TOP_INSET_PX;
    if (Math.abs(resolvedTopPx - boundaryTopPx) <= hourBoundaryClearancePx) {
      resolvedTopPx = Math.max(resolvedTopPx, boundaryTopPx + hourBoundaryOffsetPx);
    }
  });

  if (Number.isFinite(lastPlacedTopPx) && resolvedTopPx - lastPlacedTopPx < markerSpacingPx) {
    resolvedTopPx = lastPlacedTopPx + markerSpacingPx;
  }

  return Math.min(canvasHeight - TIMELINE_VIEWPORT_BOTTOM_INSET_PX, resolvedTopPx);
}