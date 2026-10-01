import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { buildPauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import type { AxisMode } from '../seriesCommon';
import { projectElapsedHoursToX } from '../seriesPredictionMath';
import {
  getPredictionTimeline,
  interpolateElapsedHoursFromTimeline,
  projectPredictionElapsedHoursToX,
} from './timeline';

export interface ItineraryXProjector {
  /** Distance le long du tracé (m) → valeur X du graphe (avant décalage d'itinéraire en mode temps). */
  toX: (distanceM: number) => number;
  /**
   * Intervalles X effectivement roulés entre `startM` et `endM`. En mode
   * temps/heure, l'intervalle est coupé aux pauses : la pause elle-même
   * n'appartient à aucun tronçon.
   */
  projectRange: (startM: number, endM: number) => Array<[number, number]>;
}

/**
 * Projection distance → X d'un itinéraire, commune aux overlays calculés en
 * distance (alertes pente, colorisation). En mode temps/heure, une prédiction
 * est requise : sans elle, `null`.
 */
export function buildItineraryXProjector(
  itinerary: Itinerary,
  prediction: PredictionResult | null | undefined,
  xMode: AxisMode,
  xOffset = 0,
): ItineraryXProjector | null {
  if (xMode === 'distance') {
    const toX = (distanceM: number) => distanceM / 1000 + xOffset;
    return {
      toX,
      projectRange: (startM, endM) => [[toX(startM), toX(endM)]],
    };
  }

  const timeline = getPredictionTimeline(prediction);
  if (!timeline) return null;

  const startTime = itinerary.rhythm.startTime;
  const pauseSchedule = buildPauseAwareSchedule(itinerary, prediction);
  const toX = (distanceM: number) =>
    projectPredictionElapsedHoursToX(
      interpolateElapsedHoursFromTimeline(timeline, distanceM),
      xMode,
      startTime,
      pauseSchedule,
    );
  const pauseSpans = (pauseSchedule?.pauseSpans ?? [])
    .filter((span) => span.durationSeconds > 0 && Number.isFinite(span.distanceM))
    .slice()
    .sort((a, b) => a.distanceM - b.distanceM);

  return {
    toX,
    projectRange: (startM, endM) => {
      const ranges: Array<[number, number]> = [];
      let pieceStartX = toX(startM);
      for (const span of pauseSpans) {
        if (span.distanceM <= startM) continue;
        if (span.distanceM >= endM) break;
        ranges.push([pieceStartX, toX(span.distanceM)]);
        // Reprise exacte après la pause (toX(distance) retombe avant la pause).
        pieceStartX = projectElapsedHoursToX(span.endScheduledSeconds / 3600, xMode, startTime);
      }
      ranges.push([pieceStartX, toX(endM)]);
      return ranges.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a);
    },
  };
}
