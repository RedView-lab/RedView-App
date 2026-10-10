/**
 * POI d'un itinéraire dont la trace a changé : la recherche corridor, ses
 * lignes de feuille de route et le tri auto portaient sur l'ancienne trace.
 * On repart de zéro (la recherche est relancée par le panneau) en ne gardant
 * que ce que l'utilisateur a posé lui-même et qui reste le long du parcours.
 */
import { CUSTOM_POI_SOURCE, type PoiCategory as FeaturePoiCategory, type PoiFeature } from '@/features/poi/types';
import { filterPoisByLateralDistance } from '@/features/poi/lib/corridor-distance-filter';

import type { Itinerary } from '../../types';
import { DEFAULT_POI_DISTANCE_M } from '../project/defaultState';
import {
  buildRouteGeometrySignature,
  projectDistanceAlongRouteM,
  roundDistanceKm,
  routeDistancesM,
} from '../routes';
import { FEATURE_TO_PANEL_POI } from './poi-to-timeline';

/**
 * Un favori / une pause reste s'il est à moins de cette distance de la
 * nouvelle trace (ou de la distance X de sa catégorie, si plus grande) : un
 * favori pris sur la carte hors corridor survit à une retouche locale, pas à
 * un parcours qui part ailleurs.
 */
const KEPT_FAVORITE_MAX_DISTANCE_M = 2000;

/** Empreinte de la trace sur laquelle les POI enregistrés ont été cherchés. */
export function buildPoiRouteSignature(routePoints: readonly { lat: number; lon: number }[] | null | undefined): string {
  return buildRouteGeometrySignature(routePoints);
}

/** POI créé à la main sur la carte : jamais retiré par un changement de trace. */
function isCustomPoi(feature: PoiFeature): boolean {
  return feature.tags?.source === CUSTOM_POI_SOURCE;
}

function isUserKeptPoi(feature: PoiFeature): boolean {
  return Boolean(feature.favorite) || (feature.pauseDurationMin ?? 0) > 0;
}

/**
 * Retire les POI de l'ancienne trace et le dernier tri auto, puis enregistre
 * l'empreinte de la nouvelle trace. Restent : les POI créés à la main, et les
 * favoris / pauses encore proches du parcours (distance recalculée). Mute
 * `itinerary`.
 */
export function resetPoisForRouteChange(itinerary: Itinerary): void {
  const routePoints = itinerary.gpxRoute?.points ?? [];
  const features = itinerary.poiFeatures ?? [];

  const custom = features.filter(isCustomPoi);
  const candidates = features.filter((feature) => !isCustomPoi(feature) && isUserKeptPoi(feature));
  let keptFavorites: PoiFeature[] = [];
  if (routePoints.length >= 2 && candidates.length > 0) {
    const maxDistanceByCategory: Partial<Record<FeaturePoiCategory, number>> = {};
    for (const feature of candidates) {
      const panelCategory = FEATURE_TO_PANEL_POI[feature.category];
      const categoryDistanceM = panelCategory
        ? (itinerary.poi?.[panelCategory]?.distanceM ?? DEFAULT_POI_DISTANCE_M)
        : DEFAULT_POI_DISTANCE_M;
      maxDistanceByCategory[feature.category] = Math.max(categoryDistanceM, KEPT_FAVORITE_MAX_DISTANCE_M);
    }
    keptFavorites = filterPoisByLateralDistance(candidates, routePoints, maxDistanceByCategory);
  }

  const kept = [...custom, ...keptFavorites];
  const keptIds = new Set<number>(kept.map((feature) => feature.id));
  const cumLengths = routePoints.length >= 2 ? routeDistancesM(routePoints) : null;

  itinerary.poiFeatures = kept;
  itinerary.timeline = itinerary.timeline
    .filter((row) => row.kind !== 'poi' || row.osmId == null || keptIds.has(row.osmId))
    .map((row) => {
      if (row.kind !== 'poi' || row.lat == null || row.lon == null) return row;
      const distM = cumLengths
        ? projectDistanceAlongRouteM({ lat: row.lat, lon: row.lon }, routePoints, cumLengths)
        : null;
      return { ...row, distanceKm: distM != null ? roundDistanceKm(distM) : null };
    });
  delete itinerary.poiAutoSort;
  itinerary.poiRouteSignature = buildPoiRouteSignature(routePoints);
}
