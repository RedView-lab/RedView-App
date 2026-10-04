import { elapsedSecondsAtDistance } from '@/features/itineraryPanel/lib/schedule/predictionElapsed';
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

/** Hauteur d'un marqueur km (20 px) + air : écart minimal entre deux marqueurs. */
const KM_MARKER_MIN_SPACING_PX = 24;
/**
 * Zone occupée par un libellé d'heure autour de sa graduation (18 px de haut,
 * 8 px au-dessus) élargie de la demi-hauteur d'un marqueur km.
 */
const HOUR_LABEL_CLEARANCE_ABOVE_PX = 19;
const HOUR_LABEL_CLEARANCE_BELOW_PX = 21;
const KM_STEP_MULTIPLIERS = [1, 2, 4, 10, 20, 40, 100];

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
  hourLabelTopsPx: readonly number[] = [],
): KmMarker[] {
  const totalDistanceM = resolveTotalDistanceM(items, prediction);
  if (totalDistanceM <= 0) return [];

  const maxTopPx = canvasHeight - TIMELINE_VIEWPORT_BOTTOM_INSET_PX;
  const candidates: Array<{ km: number; topPx: number }> = [];

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
    const topPx = (minuteOfDay - startMinutes) * pixelsPerMinute + TIMELINE_VIEWPORT_TOP_INSET_PX;
    // Hors du canevas : pas de marqueur (avant, ils s'empilaient tous en bas).
    if (topPx < TIMELINE_VIEWPORT_TOP_INSET_PX || topPx > maxTopPx) continue;
    candidates.push({ km, topPx });
  }

  // Plusieurs jours affichés : les marqueurs partagent la même colonne d'heures.
  candidates.sort((left, right) => left.topPx - right.topPx);

  // Zoom bas : on espace le pas (×2, ×4, ×10…) plutôt que de serrer les libellés.
  const multiplier = KM_STEP_MULTIPLIERS.find((factor) => {
    const kept = candidates.filter((candidate) => isMultipleOfStep(candidate.km, kmMarkerStep * factor));
    return kept.every((candidate, index) =>
      index === 0 || candidate.topPx - kept[index - 1]!.topPx >= KM_MARKER_MIN_SPACING_PX);
  }) ?? KM_STEP_MULTIPLIERS[KM_STEP_MULTIPLIERS.length - 1]!;

  const markers: KmMarker[] = [];
  let lastPlacedTopPx = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!isMultipleOfStep(candidate.km, kmMarkerStep * multiplier)) continue;
    const topPx = resolveKmMarkerTopPx(candidate.topPx, hourLabelTopsPx);
    if (topPx === null || topPx > maxTopPx) continue;
    if (topPx - lastPlacedTopPx < KM_MARKER_MIN_SPACING_PX) continue;

    lastPlacedTopPx = topPx;
    markers.push({
      id: `km-${candidate.km}`,
      label: `km${Math.round(candidate.km)}`,
      topPx,
    });
  }

  return markers;
}

function isMultipleOfStep(km: number, stepKm: number): boolean {
  const ratio = km / stepKm;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

function estimateElapsedSeconds(distanceKm: number): number {
  const fallbackSpeedKmh = 18;
  return (Math.max(0, distanceKm) / fallbackSpeedKmh) * 3600;
}

const collidesWithHourLabel = (topPx: number, hourTopPx: number) =>
  topPx > hourTopPx - HOUR_LABEL_CLEARANCE_ABOVE_PX && topPx < hourTopPx + HOUR_LABEL_CLEARANCE_BELOW_PX;

/**
 * Un marqueur posé sur un libellé d'heure glisse juste en dessous ; s'il n'y a
 * pas la place avant le libellé suivant, il est masqué (null).
 */
function resolveKmMarkerTopPx(rawTopPx: number, hourLabelTopsPx: readonly number[]): number | null {
  const blocking = hourLabelTopsPx.find((hourTopPx) => collidesWithHourLabel(rawTopPx, hourTopPx));
  if (blocking === undefined) return rawTopPx;
  const shiftedTopPx = blocking + HOUR_LABEL_CLEARANCE_BELOW_PX;
  return hourLabelTopsPx.some((hourTopPx) => collidesWithHourLabel(shiftedTopPx, hourTopPx))
    ? null
    : shiftedTopPx;
}
