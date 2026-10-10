import type { GpxRoute, PoiFeature } from '@/features/poi/types';
import {
  buildPoiRouteSignature,
  buildPoiSearchSignature,
  poiFeaturesToTimelineItems,
} from '../../lib/schedule';
import { projectDistanceAlongRouteM, roundDistanceKm, routeDistancesM } from '../../lib/routes';
import type { ItineraryProject, TimelineItem } from '../../types';
import { mergePoiFeatureFavorites } from './poiFeatureUtils';

/**
 * Résultat de la recherche POI le long du corridor, appliqué à un itinéraire
 * cible. Transformation pure du projet.
 */

/**
 * Ligne POI marquée par l'utilisateur : favori posé à la main (et sa pause),
 * ou nom saisi dans la colonne « Nom ». Jamais retirée par une recherche qui
 * ne la renvoie plus (catégorie décochée, couloir réduit, POI sorti de la
 * base) : la nuit réservée et sa pause disparaissaient sinon du plan.
 */
function isUserMarkedPoiRow(row: TimelineItem): boolean {
  return (Boolean(row.favorite) && row.favoriteSource !== 'auto') || row.labelEdited === true;
}

/**
 * Recherche terminée : remplace les lignes POI automatiques de la feuille de
 * route par les résultats (favoris, pauses, visibilité et noms saisis reportés
 * sur les POI retrouvés), garde les lignes marquées par l'utilisateur que la
 * recherche ne renvoie plus (kilométrage recalculé sur le tracé courant), et
 * mémorise les empreintes de recherche et de trace.
 */
export function applyCorridorComplete(
  p: ItineraryProject,
  targetId: string,
  features: PoiFeature[],
  searchedRoutePoints: GpxRoute['points'],
): ItineraryProject {
  const target = p.itineraries.find((i) => i.id === targetId);
  if (!target) return p;
  const route = target.gpxRoute?.points;
  if (!route || route.length < 2) return p;
  const mergedFeatures = mergePoiFeatureFavorites(
    features,
    target.timeline,
    target.poiFeatures ?? [],
    target.rhythm,
  );

  const existingPoiRows = new Map(
    target.timeline
      .filter((row) => row.kind === 'poi' && row.osmId != null)
      .map((row) => [row.osmId as number, row]),
  );

  const newPoiRows = poiFeaturesToTimelineItems(mergedFeatures, route).map((row) => {
    const previous = row.osmId != null ? existingPoiRows.get(row.osmId) : undefined;
    if (!previous) return row;
    const favorite = Boolean(previous.favorite || row.favorite);
    const origin = previous.favorite ? previous : row;
    return {
      ...row,
      favorite,
      visible: previous.visible ?? row.visible,
      ...(favorite && origin?.favoriteSource ? { favoriteSource: origin.favoriteSource } : {}),
      ...(favorite && origin?.autoReason ? { autoReason: origin.autoReason } : {}),
      // Pause du favori (y compris 0 : pause décochée) : l'agenda, la synthèse
      // et l'export la lisent sur la ligne ; la perdre raccourcissait le plan.
      ...(previous.durationMin !== undefined ? { durationMin: previous.durationMin } : {}),
      // Nom saisi dans la colonne « Nom » : jamais écrasé par le nom OSM.
      ...(previous.labelEdited ? { label: previous.label, labelEdited: true } : {}),
    };
  });

  // Lignes marquées que la recherche n'a pas renvoyées : gardées, avec leur POI sur la carte.
  const foundIds = new Set(newPoiRows.map((row) => row.osmId));
  const cumulativeM = routeDistancesM(route);
  const keptRows = target.timeline
    .filter((row) => row.kind === 'poi' && isUserMarkedPoiRow(row) && !foundIds.has(row.osmId))
    .map((row) => {
      if (row.lat == null || row.lon == null) return row;
      const distanceM = projectDistanceAlongRouteM({ lat: row.lat, lon: row.lon }, route, cumulativeM);
      return distanceM == null ? row : { ...row, distanceKm: roundDistanceKm(distanceM) };
    });
  const keptIds = new Set(keptRows.map((row) => row.osmId).filter((id): id is number => id != null));
  const mergedIds = new Set(mergedFeatures.map((feature) => feature.id));
  const keptFeatures = (target.poiFeatures ?? []).filter((feature) => keptIds.has(feature.id) && !mergedIds.has(feature.id));
  const poiRows = keptRows.length > 0
    ? [...newPoiRows, ...keptRows].sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0))
    : newPoiRows;
  const storedFeatures = keptFeatures.length > 0 ? [...mergedFeatures, ...keptFeatures] : mergedFeatures;

  const stripped = target.timeline.filter((row) => row.kind !== 'poi');
  const endIdx = stripped.findIndex((row) => row.kind === 'end');
  const insertAt = endIdx >= 0 ? endIdx : stripped.length;
  const merged = [
    ...stripped.slice(0, insertAt),
    ...poiRows,
    ...stripped.slice(insertAt),
  ];

  return {
    ...p,
    itineraries: p.itineraries.map((it) =>
      it.id === targetId
        ? {
          ...it,
          timeline: merged,
          poiFeatures: storedFeatures,
          poiSearchSignature: buildPoiSearchSignature(target.poi),
          // Trace interrogée, pas la courante : si elle a bougé pendant
          // la recherche, l'écart relance une recherche.
          poiRouteSignature: buildPoiRouteSignature(searchedRoutePoints),
        }
        : it,
    ),
  };
}
