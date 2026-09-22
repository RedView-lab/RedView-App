// ─────────────────────────────────────────────────────────────────────
// Corridor distance filter — « tous les POI à X mètres »
// ─────────────────────────────────────────────────────────────────────
//
// Remplace l'ancien pipeline d'affinage (`refine-corridor-pois.ts`) qui
// décidait, à la place de l'utilisateur, quels POI méritaient d'être vus :
//
//   - plafond de densité de 4 POI par catégorie et par km glissant,
//   - espacement minimal de 175 m entre deux POI d'une même catégorie,
//   - suppression des POI « fermés » à l'heure de passage estimée,
//   - espacement minimal en secondes par catégorie,
//   - plafond d'hôtels par nuit,
//   - et un plafond latéral de repli caché à 500 m pour toute catégorie
//     sans distance configurée.
//
// Résultat : seul un sous-ensemble arbitraire des POI réellement présents
// dans le corridor était affiché.
//
// Ce module ne fait plus qu'UNE chose, et de façon strictement
// conservative : garder **tout** POI dont la distance latérale à la trace
// est inférieure ou égale à la distance X configurée pour sa catégorie.
// Aucun plafond de densité, aucun tri par score, aucune exclusion horaire.
//
// Une catégorie sans distance X configurée est conservée intégralement
// (elle est déjà bornée par le rayon du corridor côté serveur, qui vaut
// le maximum des X activés).

import type { GpxRoute, PoiCategory, PoiFeature } from '../types';
import { projectPoiOntoRoute, projectRoutePoints } from './refinePoiProjection';

/**
 * Keep every feature whose lateral distance to the route is within the
 * distance configured for its category.
 *
 * @param maxLateralDistanceByCategory Per-category X (metres). Categories
 *   absent from the map are kept untouched.
 * @param fallbackMaxLateralDistanceM Optional global X used for categories
 *   missing from the map. When omitted (the default), those categories are
 *   kept untouched — the corridor radius is the only bound.
 */
export function filterPoisByLateralDistance(
  features: PoiFeature[],
  routePoints: GpxRoute['points'],
  maxLateralDistanceByCategory?: Partial<Record<PoiCategory, number>>,
  fallbackMaxLateralDistanceM?: number,
): PoiFeature[] {
  if (features.length === 0) return [];
  if (routePoints.length < 2) return features;
  if (!maxLateralDistanceByCategory && fallbackMaxLateralDistanceM == null) {
    return features;
  }

  const projectedRoute = projectRoutePoints(routePoints);
  const kept: PoiFeature[] = [];

  for (const feature of features) {
    const limit =
      maxLateralDistanceByCategory?.[feature.category] ?? fallbackMaxLateralDistanceM;
    if (limit == null || !Number.isFinite(limit) || limit <= 0) {
      kept.push(feature);
      continue;
    }
    const { lateralDistanceM } = projectPoiOntoRoute(feature, projectedRoute);
    if (lateralDistanceM <= limit) kept.push(feature);
  }

  return kept;
}
