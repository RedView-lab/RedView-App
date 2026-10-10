/**
 * Branchement du tri automatique des POI (`@/features/poi/lib/autoSort`) sur
 * un itinéraire : construction du modèle horaire (prédiction, pauses
 * existantes, heure de départ). Le résultat est un filtre, pas des favoris :
 * la feuille de route ne garde que les POI retenus (et les favoris), la
 * timeline n'en reçoit aucun.
 */
import type { PredictionResult } from '@/features/fitPredictor';
import {
  autoSortPois,
  type AutoSortResult,
  type AutoSortTimeModel,
} from '@/features/poi/lib/autoSort';
import { projectRoutePoints } from '@/features/poi/lib/refinePoiProjection';
import { POI_LABELS, type PoiAutoSortReason, type PoiFeature } from '@/features/poi/types';

import type {
  Itinerary,
  PoiAutoSortPickRef,
  PoiCategory as PanelPoiCategory,
  PoiState,
  TimelineItem,
} from '../../types';
import { DEFAULT_POI_DISTANCE_M, normalizeItineraryRhythmState } from '../project/defaultState';
import { buildPauseAwareSchedule } from './pauseAwareSchedule';
import { resolveScheduleStart, rideSecondsModel } from './passageClock';
import { FEATURE_TO_PANEL_POI } from './poi-to-timeline';

export interface PoiAutoSortRun {
  result: AutoSortResult;
  /** false : horaires estimés à 18 km/h faute de prédiction. */
  usedPrediction: boolean;
}

/**
 * Empreinte des réglages de recherche POI (catégories cochées + distances X).
 * Comparée à `Itinerary.poiSearchSignature` pour savoir si les POI chargés
 * correspondent encore aux réglages affichés.
 */
export function buildPoiSearchSignature(poi: PoiState | null | undefined): string {
  if (!poi) return '';
  return (Object.keys(poi) as PanelPoiCategory[])
    .filter((key) => poi[key]?.enabled)
    .sort()
    .map((key) => `${key}:${poi[key].distanceM ?? ''}`)
    .join('|');
}

/**
 * Empreinte des POI chargés (indépendante de l'ordre et des favoris) : c'est
 * ce jeu de POI, et non les réglages affichés, que le tri a vu.
 */
function fingerprintPoiFeatures(features: readonly PoiFeature[] | undefined): string {
  if (!features || features.length === 0) return '0';
  let sum = 0;
  let xor = 0;
  for (const feature of features) {
    const id = Number(feature.id) % 2_147_483_647;
    sum = (sum + id) % 4_294_967_296;
    xor = (xor ^ id) >>> 0;
  }
  return `${features.length}:${sum.toString(36)}:${xor.toString(36)}`;
}

/**
 * Empreinte des entrées du tri auto : POI chargés, heure / date de départ,
 * pauses aux favoris (manuels, déjà planifiés) et prédiction. Si elle
 * change, le dernier tri est périmé et il est relancé.
 */
export function buildPoiAutoSortSignature(
  itinerary: Itinerary,
  prediction: PredictionResult | null | undefined,
): string {
  const rhythm = normalizeItineraryRhythmState(itinerary.rhythm);
  const pauses = rhythm.pauseAtFavoritePois ? JSON.stringify(rhythm.poiPauseDurations) : 'off';
  const predictionKey = prediction && prediction.points.length >= 2
    ? `${Math.round(prediction.total_time_s)}:${Math.round(prediction.total_distance_m)}`
    : 'none';
  return [
    fingerprintPoiFeatures(itinerary.poiFeatures),
    // Catégories cochées / distances : elles bornent ce que le tri considère.
    buildPoiSearchSignature(itinerary.poi),
    rhythm.startDate ?? '',
    rhythm.startTime ?? '',
    pauses,
    predictionKey,
  ].join('#');
}

/** Un favori est « manuel » sauf s'il a explicitement été posé par le tri auto. */
function isManualFavorite(item: { favorite?: boolean; favoriteSource?: string }): boolean {
  return Boolean(item.favorite) && item.favoriteSource !== 'auto';
}

/**
 * Lance le tri auto sur l'itinéraire. Ne modifie rien : le résultat est
 * enregistré dans `Itinerary.poiAutoSort.picks` (voir `toPoiAutoSortPickRefs`).
 * Renvoie null sans trace ou sans POI chargés.
 */
export function computePoiAutoSort(
  itinerary: Itinerary,
  prediction: PredictionResult | null | undefined,
  now: Date = new Date(),
): PoiAutoSortRun | null {
  const routePoints = itinerary.gpxRoute?.points ?? [];
  const features = itinerary.poiFeatures ?? [];
  if (routePoints.length < 2 || features.length === 0) return null;

  const rhythm = normalizeItineraryRhythmState(itinerary.rhythm);
  const usablePrediction = prediction && prediction.points.length >= 2 ? prediction : null;

  // Ne trier que ce que l'utilisateur voit : catégories cochées, distance X.
  const entryFor = (feature: PoiFeature) => {
    const panelCategory = FEATURE_TO_PANEL_POI[feature.category];
    return panelCategory ? itinerary.poi?.[panelCategory] : undefined;
  };
  const visible = features.filter((feature) => entryFor(feature)?.enabled);

  const manualFavoriteIds = new Set<string | number>();
  for (const row of itinerary.timeline) {
    if (row.kind === 'poi' && row.osmId != null && isManualFavorite(row)) manualFavoriteIds.add(row.osmId);
  }
  for (const feature of features) {
    if (isManualFavorite(feature)) manualFavoriteIds.add(feature.id);
  }

  // Pauses déjà planifiées, sans celles des anciens favoris auto (effacés au tri).
  const baseItinerary: Itinerary = {
    ...itinerary,
    timeline: itinerary.timeline.map((row) =>
      row.favoriteSource === 'auto' ? { ...row, favorite: false } : row,
    ),
  };
  const baseStopAnchors = usablePrediction
    ? (buildPauseAwareSchedule(baseItinerary, usablePrediction)?.stopAnchors ?? [])
    : [];

  // Pas de date : départ supposé demain, jour de semaine traité comme inconnu.
  const { start, hasRealDate } = resolveScheduleStart(rhythm, now);

  const projected = projectRoutePoints(routePoints);
  const routeTotalM = projected[projected.length - 1]?.progressM ?? 0;

  const time: AutoSortTimeModel = {
    rideSecondsAt: rideSecondsModel(usablePrediction, routeTotalM),
    baseStopAnchors,
    start,
    hasRealDate,
    // Les POI retenus ne vont pas dans la timeline : ils ne posent pas de
    // pause, l'horaire du tri reste celui affiché par la feuille de route.
    pauseMinutesFor: () => 0,
  };

  const result = autoSortPois({
    features: visible,
    routePoints,
    time,
    manualFavoriteIds,
    maxLateralMFor: (feature) => entryFor(feature)?.distanceM ?? DEFAULT_POI_DISTANCE_M,
  });
  return { result, usedPrediction: usablePrediction != null };
}

/**
 * Crée (ou retrouve) la ligne timeline d'un POI et l'insère à sa place
 * kilométrique, avant la ligne d'arrivée.
 */
export function upsertPoiTimelineRow(
  itinerary: Itinerary,
  feature: PoiFeature,
  distanceKm: () => number | null,
): TimelineItem {
  const existing = itinerary.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
  if (existing) {
    if (existing.distanceKm == null) existing.distanceKm = distanceKm();
    return existing;
  }

  const km = distanceKm();
  const row: TimelineItem = {
    id: `poi-timeline-${feature.id}`,
    kind: 'poi',
    label: feature.name?.trim() || POI_LABELS[feature.category] || 'POI',
    lat: feature.lat,
    lon: feature.lon,
    osmId: feature.id,
    poiCategory: FEATURE_TO_PANEL_POI[feature.category],
    visible: true,
    distanceKm: km,
  };

  let insertAt = itinerary.timeline.findIndex((item) => item.kind === 'end');
  if (insertAt < 0) insertAt = itinerary.timeline.length;
  if (km != null) {
    const byDistance = itinerary.timeline.findIndex(
      (item) =>
        item.kind !== 'start' &&
        (item.kind === 'end' || (item.distanceKm != null && item.distanceKm > km)),
    );
    if (byDistance >= 0) insertAt = byDistance;
  }
  itinerary.timeline.splice(insertAt, 0, row);
  return row;
}

/**
 * Retire les favoris posés par l'ancien tri auto (avant qu'il devienne un
 * filtre) ; les favoris manuels restent. Mute `itinerary`.
 */
export function clearPoiAutoSortFavorites(itinerary: Itinerary): void {
  for (const row of itinerary.timeline) {
    if (row.favoriteSource !== 'auto') continue;
    row.favorite = false;
    delete row.favoriteSource;
    delete row.autoReason;
  }
  if (itinerary.poiFeatures) {
    itinerary.poiFeatures = itinerary.poiFeatures.map((feature) => {
      if (feature.favoriteSource !== 'auto') return feature;
      const next: PoiFeature = { ...feature, favorite: false };
      delete next.favoriteSource;
      delete next.autoReason;
      return next;
    });
  }
}

/** Références persistées des POI retenus par un tri. */
export function toPoiAutoSortPickRefs(run: PoiAutoSortRun): PoiAutoSortPickRef[] {
  return run.result.picks.map((pick) => ({ id: pick.feature.id, reason: pick.reason }));
}

/** Index id OSM → règle des POI retenus. */
export function indexPoiAutoSortPicks(
  picks: readonly PoiAutoSortPickRef[],
): ReadonlyMap<number, PoiAutoSortReason> {
  return new Map(picks.map((pick) => [pick.id, pick.reason]));
}

/**
 * POI retenus par le tri auto actif, ou null si le filtre ne s'applique pas
 * (toggle éteint, jamais trié ou tri d'avant le filtrage).
 */
export function getPoiAutoSortPicks(
  itinerary: Pick<Itinerary, 'poiAutoSortEnabled' | 'poiAutoSort'> | null | undefined,
): ReadonlyMap<number, PoiAutoSortReason> | null {
  const picks = itinerary?.poiAutoSortEnabled ? itinerary.poiAutoSort?.picks : undefined;
  return picks ? indexPoiAutoSortPicks(picks) : null;
}

/**
 * Ligne gardée par le filtre du tri auto : tout sauf les POI de la recherche
 * corridor ni retenus, ni favoris, ni marqués d'une pause.
 */
export function keepsTimelineItemWithPoiAutoSort(
  item: TimelineItem,
  picks: ReadonlyMap<number, PoiAutoSortReason>,
): boolean {
  if (item.kind !== 'poi' || item.osmId == null) return true;
  if (item.favorite || (item.durationMin ?? 0) > 0) return true;
  return picks.has(item.osmId);
}
