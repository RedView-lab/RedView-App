/**
 * Branchement du tri automatique des POI (`@/features/poi/lib/autoSort`) sur
 * un itinéraire : construction du modèle horaire (prédiction, pauses
 * existantes, heure de départ) puis application du résultat en favoris
 * « auto » sur la timeline et les POI du corridor.
 */
import type { PredictionResult } from '@/features/fitPredictor';
import {
  autoSortPois,
  type AutoSortPick,
  type AutoSortResult,
  type AutoSortTimeModel,
} from '@/features/poi/lib/autoSort';
import { projectRoutePoints } from '@/features/poi/lib/refinePoiProjection';
import { POI_LABELS, type PoiFeature } from '@/features/poi/types';

import { parseStartReference } from '../../sections/timeline/TimelineTimelineView/utils';
import type { Itinerary, PoiCategory as PanelPoiCategory, PoiState, TimelineItem } from '../../types';
import { normalizeItineraryRhythmState } from '../project/defaultState';
import { cumulativeRouteLengthsM, projectDistanceAlongRouteM, roundDistanceKm } from '../routes';
import { buildPauseAwareSchedule } from './pauseAwareSchedule';
import { FEATURE_TO_PANEL_POI } from './poi-to-timeline';

/** Vitesse de repli quand aucune prédiction n'est disponible. */
const FALLBACK_SPEED_MS = 18 / 3.6;
const DEFAULT_MAX_LATERAL_M = 40;

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
 * pauses aux favoris et prédiction. Si elle change, le dernier tri est
 * périmé et le panneau propose « Re-trier ».
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

function rideSecondsModel(
  prediction: PredictionResult | null,
  routeTotalM: number,
): (progressM: number) => number {
  const points = prediction?.points ?? [];
  if (points.length < 2 || routeTotalM <= 0) {
    return (progressM) => progressM / FALLBACK_SPEED_MS;
  }
  // La prédiction travaille sur sa propre trace rééchantillonnée : on passe
  // par la fraction parcourue pour rester insensible aux écarts de longueur.
  const predictionTotalM = points[points.length - 1]!.distance_m;
  return (progressM) => {
    const d = (progressM / routeTotalM) * predictionTotalM;
    if (d <= points[0]!.distance_m) return points[0]!.elapsed_time_s;
    let lo = 0;
    let hi = points.length - 1;
    if (d >= points[hi]!.distance_m) return points[hi]!.elapsed_time_s;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid]!.distance_m <= d) lo = mid;
      else hi = mid;
    }
    const a = points[lo]!;
    const b = points[hi]!;
    const span = b.distance_m - a.distance_m;
    if (span <= 0) return a.elapsed_time_s;
    return a.elapsed_time_s + ((d - a.distance_m) / span) * (b.elapsed_time_s - a.elapsed_time_s);
  };
}

/**
 * Lance le tri auto sur l'itinéraire. Ne modifie rien : voir
 * `applyPoiAutoSort`. Renvoie null sans trace ou sans POI chargés.
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

  // Pauses déjà planifiées, sans celles des favoris auto qu'on va remplacer.
  const baseItinerary: Itinerary = {
    ...itinerary,
    timeline: itinerary.timeline.map((row) =>
      row.favoriteSource === 'auto' ? { ...row, favorite: false } : row,
    ),
  };
  const baseStopAnchors = usablePrediction
    ? (buildPauseAwareSchedule(baseItinerary, usablePrediction)?.stopAnchors ?? [])
    : [];

  const reference = parseStartReference(rhythm);
  let start: Date;
  if (reference.hasRealDate && reference.reference) {
    start = reference.reference;
  } else {
    // Pas de date : départ supposé demain, jour de semaine traité comme inconnu.
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    start.setMinutes(reference.startMinutes);
  }

  const projected = projectRoutePoints(routePoints);
  const routeTotalM = projected[projected.length - 1]?.progressM ?? 0;

  const time: AutoSortTimeModel = {
    rideSecondsAt: rideSecondsModel(usablePrediction, routeTotalM),
    baseStopAnchors,
    start,
    hasRealDate: reference.hasRealDate,
    pauseMinutesFor: (feature) => {
      if (!rhythm.pauseAtFavoritePois) return 0;
      const panelCategory = FEATURE_TO_PANEL_POI[feature.category];
      const minutes = panelCategory ? rhythm.poiPauseDurations[panelCategory] : null;
      return minutes != null && minutes > 0 ? minutes : 0;
    },
  };

  const result = autoSortPois({
    features: visible,
    routePoints,
    time,
    manualFavoriteIds,
    maxLateralMFor: (feature) => entryFor(feature)?.distanceM ?? DEFAULT_MAX_LATERAL_M,
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
 * Remplace les favoris auto précédents par ceux de `picks`. Les favoris
 * manuels ne sont jamais touchés. Mute `itinerary` (brouillon).
 */
export function applyPoiAutoSort(itinerary: Itinerary, picks: readonly AutoSortPick[]): void {
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

  const routePoints = itinerary.gpxRoute?.points ?? [];
  const cumulative = routePoints.length >= 2 ? cumulativeRouteLengthsM(routePoints) : null;
  const pickById = new Map<string | number, AutoSortPick>();
  for (const pick of picks) pickById.set(pick.feature.id, pick);

  for (const pick of pickById.values()) {
    const row = upsertPoiTimelineRow(itinerary, pick.feature, () => {
      if (!cumulative) return null;
      const distM = projectDistanceAlongRouteM(pick.feature, routePoints, cumulative);
      return distM != null ? roundDistanceKm(distM) : null;
    });
    if (isManualFavorite(row)) continue;
    row.favorite = true;
    row.favoriteSource = 'auto';
    row.autoReason = pick.reason;
  }

  if (!itinerary.poiFeatures) itinerary.poiFeatures = [];
  const known = new Set(itinerary.poiFeatures.map((feature) => feature.id));
  itinerary.poiFeatures = itinerary.poiFeatures.map((feature) => {
    const pick = pickById.get(feature.id);
    if (!pick || isManualFavorite(feature)) return feature;
    return { ...feature, favorite: true, favoriteSource: 'auto', autoReason: pick.reason };
  });
  for (const pick of pickById.values()) {
    if (known.has(pick.feature.id)) continue;
    itinerary.poiFeatures.push({ ...pick.feature, favorite: true, favoriteSource: 'auto', autoReason: pick.reason });
  }
}
