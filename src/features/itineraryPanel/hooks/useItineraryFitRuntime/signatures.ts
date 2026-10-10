import { normalizeDiscipline, resolvePredictionDiscipline, type SportDiscipline } from '@/shared/lib/discipline';
import { canonicalJson } from '../../lib/project/canonicalJson';
import { buildFitUploadsSignature } from '../../lib/schedule';
import type { Itinerary } from '../../types';
import { isCyclingPredictionOutdated } from './cycling';

type GpxRoute = NonNullable<Itinerary['gpxRoute']>;
type SignedPoint = {
  lat: number;
  lon: number;
  elevationM?: number | null;
  surface?: string;
  roughness?: number;
  wayCode?: number;
};

/**
 * Version du format de l'empreinte : une estampille d'un autre format ne
 * correspond plus, la prédiction stockée est recalculée une fois.
 */
const ROUTE_SIGNATURE_VERSION = 'r2';

/**
 * Empreinte de tout ce que le moteur lit d'un tableau de points : position
 * (1e-5°), altitude (dm), revêtement, rugosité, contexte de voie. Deux FNV-1a
 * 32 bits de graines différentes (64 bits). Les tableaux de points ne sont
 * jamais modifiés en place (historyClone.ts) : mise en cache par tableau.
 */
const pointsHashCache = new WeakMap<ReadonlyArray<SignedPoint>, string>();

function hashRoutePoints(points: ReadonlyArray<SignedPoint>): string {
  const cached = pointsHashCache.get(points);
  if (cached !== undefined) return cached;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  const mix = (value: number) => {
    h1 = Math.imul(h1 ^ (value | 0), 0x01000193);
    h2 = Math.imul(h2 ^ ((value | 0) + 0x9e3779b9), 0x01000193);
  };
  for (const point of points) {
    mix(Math.round(point.lat * 1e5));
    mix(Math.round(point.lon * 1e5));
    const elevationM = point.elevationM;
    mix(typeof elevationM === 'number' && Number.isFinite(elevationM) ? Math.round(elevationM * 10) : 0x7fffffff);
    const surface = point.surface ?? '';
    for (let index = 0; index < surface.length; index += 1) mix(surface.charCodeAt(index));
    mix(point.roughness ?? -1);
    mix(point.wayCode ?? -1);
  }
  const hash = `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
  pointsHashCache.set(points, hash);
  return hash;
}

/**
 * Signature du tracé pour la prédiction : son contenu entier (les altitudes
 * affinées par l'IGN ou les revêtements analysés après coup changent le
 * résultat sans toucher à la géométrie), points d'origine d'un GPX importé
 * compris (le moteur vélo les préfère quand ils décrivent le même tracé).
 */
export function buildRouteSignature(route: Pick<GpxRoute, 'points' | 'originalPoints'> | null | undefined): string {
  const points = route?.points;
  if (!points || points.length < 2) return '';
  const last = points[points.length - 1];
  const pointsHash = hashRoutePoints(points);
  // Par contenu, pas par référence : un rognage ou une découpe font de
  // `originalPoints` le tableau `points` lui-même, et après un rechargement ou
  // une matérialisation collab ce sont deux tableaux égaux — l'empreinte doit
  // rester la même partout (sinon recalcul à chaque ouverture, et va-et-vient
  // entre deux éditeurs qui ne calculent pas la même).
  const originalHash = route.originalPoints && route.originalPoints !== points && route.originalPoints.length >= 2
    ? hashRoutePoints(route.originalPoints)
    : pointsHash;
  const original = originalHash !== pointsHash ? `|o${route.originalPoints!.length}:${originalHash}` : '';
  return `${ROUTE_SIGNATURE_VERSION}|${points.length}|${last?.distanceM ?? ''}|${pointsHash}${original}`;
}

/** Entrées d'une prédiction : un résultat n'est valable que pour elles. */
export function buildPredictionInputSignature(itinerary: Itinerary): string {
  return [
    buildRouteSignature(itinerary.gpxRoute),
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

/**
 * La prédiction stockée de `itinerary` vaut-elle pour ses entrées actuelles ?
 * Estampille présente : elle doit correspondre (et le moteur vélo être à jour).
 * Sans estampille (prédiction antérieure à `predictionInputsKey`), à la
 * première ouverture seulement : même distance à 500 m près, même discipline.
 * Une estampille présente mais différente se recalcule toujours : un rythme
 * changé juste avant de fermer l'onglet gardait sinon l'ancien résultat.
 */
export function storedPredictionStillValid(
  itinerary: Itinerary,
  discipline: SportDiscipline,
  { firstPass }: { firstPass: boolean },
): boolean {
  const prediction = itinerary.prediction;
  if (!prediction || itinerary.pendingFitRecompute === true || isCyclingPredictionOutdated(prediction)) return false;
  if (itinerary.predictionInputsKey !== undefined) {
    return itinerary.predictionInputsKey === buildPredictionStamp(itinerary);
  }
  if (!firstPass) return false;
  const points = itinerary.gpxRoute?.points;
  const routeDistanceM = points?.[points.length - 1]?.distanceM ?? 0;
  return Math.abs((prediction.total_distance_m ?? 0) - routeDistanceM) <= 500
    && resolvePredictionDiscipline(prediction) === discipline;
}
