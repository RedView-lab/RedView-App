import { normalizeDiscipline } from '@/shared/lib/discipline';
import { canonicalJson } from '../../lib/project/canonicalJson';
import { buildFitUploadsSignature } from '../../lib/schedule';
import type { Itinerary } from '../../types';

type RoutePoints = NonNullable<Itinerary['gpxRoute']>['points'];

export function buildRouteSignature(points: RoutePoints | null | undefined): string {
  if (!points || points.length < 2) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return [
    points.length,
    first ? `${first.lon.toFixed(5)},${first.lat.toFixed(5)}` : '',
    last ? `${last.lon.toFixed(5)},${last.lat.toFixed(5)}` : '',
    last?.distanceM ?? '',
  ].join('|');
}

/** Entrées d'une prédiction : un résultat n'est valable que pour elles. */
export function buildPredictionInputSignature(itinerary: Itinerary): string {
  return [
    buildRouteSignature(itinerary.gpxRoute?.points),
    normalizeDiscipline(itinerary.discipline),
    // JSON canonique : l'ordre des clés d'un rythme fusionné (co-édition) varie.
    canonicalJson(itinerary.rhythm ?? null),
  ].join('::');
}

/**
 * Estampille persistée avec une prédiction (`predictionInputsKey`) : ses
 * entrées, fichiers .fit compris. Tant qu'elle correspond, la prédiction
 * stockée est à jour.
 */
export function buildPredictionStamp(itinerary: Itinerary): string {
  return `${buildPredictionInputSignature(itinerary)}::${buildFitUploadsSignature(itinerary.fitUploads ?? [])}`;
}
