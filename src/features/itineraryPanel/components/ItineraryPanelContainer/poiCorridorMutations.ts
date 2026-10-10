import type { GpxRoute, PoiFeature } from '@/features/poi/types';
import {
  buildPoiRouteSignature,
  buildPoiSearchSignature,
  poiFeaturesToTimelineItems,
} from '../../lib/schedule';
import type { ItineraryProject } from '../../types';
import { mergePoiFeatureFavorites } from './poiFeatureUtils';

/**
 * Résultat de la recherche POI le long du corridor, appliqué à un itinéraire
 * cible. Transformation pure du projet.
 */

/**
 * Recherche terminée : remplace les lignes POI de la feuille de route (en
 * gardant favoris/visibilité des lignes déjà présentes) et mémorise les
 * empreintes de recherche et de trace.
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

  const stripped = target.timeline.filter((row) => row.kind !== 'poi');
  const endIdx = stripped.findIndex((row) => row.kind === 'end');
  const insertAt = endIdx >= 0 ? endIdx : stripped.length;
  const merged = [
    ...stripped.slice(0, insertAt),
    ...newPoiRows,
    ...stripped.slice(insertAt),
  ];

  return {
    ...p,
    itineraries: p.itineraries.map((it) =>
      it.id === targetId
        ? {
          ...it,
          timeline: merged,
          poiFeatures: mergedFeatures,
          poiSearchSignature: buildPoiSearchSignature(target.poi),
          // Trace interrogée, pas la courante : si elle a bougé pendant
          // la recherche, l'écart relance une recherche.
          poiRouteSignature: buildPoiRouteSignature(searchedRoutePoints),
        }
        : it,
    ),
  };
}
