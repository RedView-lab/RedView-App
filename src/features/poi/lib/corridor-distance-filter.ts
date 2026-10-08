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
import { projectPoiOntoRoute, projectRoutePoints, type ProjectedRoutePoint } from './refinePoiProjection';

/**
 * Trace projetée par tableau de points : la carte refiltre à chaque bascule /
 * tick de recherche avec la même trace, et projeter 20 à 30 k points (plus
 * l'index de morceaux construit à la demande sur le résultat) à chaque fois
 * était du pur gâchis.
 */
const projectedRouteCache = new WeakMap<GpxRoute['points'], ProjectedRoutePoint[]>();

function getProjectedRoute(routePoints: GpxRoute['points']): ProjectedRoutePoint[] {
  let projected = projectedRouteCache.get(routePoints);
  if (!projected) {
    projected = projectRoutePoints(routePoints);
    projectedRouteCache.set(routePoints, projected);
  }
  return projected;
}

/**
 * Garde chaque objet dont la distance latérale à la trace reste dans la
 * distance réglée pour sa catégorie.
 *
 * @param maxLateralDistanceByCategory X par catégorie (mètres). Les catégories
 *   absentes de la table sont gardées telles quelles.
 * @param fallbackMaxLateralDistanceM X global optionnel pour les catégories
 *   absentes de la table. Omis (par défaut), ces catégories sont gardées telles
 *   quelles — le rayon du corridor est la seule borne.
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

  const projectedRoute = getProjectedRoute(routePoints);
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
