import { buildPauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import { getItineraryStartDistanceKm } from '@/features/itineraryPanel/lineage/itineraryLineage';
import type { Itinerary } from '@/features/itineraryPanel/types';
import {
  getRoutePointDistances,
  interpolateRoutePointAtDistance,
  projectXToDistanceM,
  type AxisMode,
} from '../chart';

type Prediction = Parameters<typeof buildPauseAwareSchedule>[1];

/**
 * Où « Ajouter » pose l'élément quand on clique le profil en `xValue` :
 * `outside` hors de la courbe de l'itinéraire actif (portion d'une autre
 * variante, au-delà de l'arrivée), sinon le point de la trace et sa distance
 * depuis le départ ; null si la trace ne donne pas de point.
 */
export function resolveChartPlacementTarget(params: {
  xValue: number;
  /** Étendue en X de la courbe de l'itinéraire actif, null si inconnue. */
  activeChartXRange: { min: number; max: number } | null;
  itinerary: Itinerary;
  points: NonNullable<Itinerary['gpxRoute']>['points'];
  prediction: Prediction;
  xMode: AxisMode;
}): { kind: 'outside' } | { kind: 'point'; point: { lat: number; lon: number }; routeDistanceM: number } | null {
  const { xValue, activeChartXRange, itinerary, points, prediction, xMode } = params;
  if (activeChartXRange) {
    const margin = (activeChartXRange.max - activeChartXRange.min) * 0.002;
    if (xValue < activeChartXRange.min - margin || xValue > activeChartXRange.max + margin) {
      return { kind: 'outside' };
    }
  }

  const distances = getRoutePointDistances(points);
  const totalM = distances[distances.length - 1] ?? 0;
  const localXValue = xMode === 'distance' ? xValue - getItineraryStartDistanceKm(itinerary) : xValue;
  const distanceM = projectXToDistanceM(
    points,
    prediction,
    xMode,
    localXValue,
    itinerary.rhythm.startTime,
    buildPauseAwareSchedule(itinerary, prediction),
  );
  // Hors du profil actif (portion d'une autre variante, au-delà de l'arrivée).
  const toleranceM = Math.max(25, totalM * 0.002);
  if (!Number.isFinite(distanceM) || distanceM < -toleranceM || distanceM > totalM + toleranceM) {
    return { kind: 'outside' };
  }

  const routeDistanceM = Math.min(totalM, Math.max(0, distanceM));
  const point = interpolateRoutePointAtDistance(points, routeDistanceM);
  if (!point) return null;
  return { kind: 'point', point, routeDistanceM };
}
