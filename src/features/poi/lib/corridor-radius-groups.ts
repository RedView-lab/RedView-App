/**
 * Regroupement des catégories d'une recherche corridor par rayon.
 *
 * Le serveur POI ne prend qu'un rayon par requête. Interroger toutes les
 * catégories au rayon de la ligne la plus large (les cimetières à 100 m)
 * ferait chercher restaurants, hôtels, commerces… à 125 m au lieu de 25 m :
 * ~5× plus de surface balayée et de POI renvoyés, aussitôt jetés par le
 * filtre latéral. Une requête par rayon, bornée à `maxGroups` : au-delà, les
 * rayons voisins (plus petit rapport) sont fusionnés au plus large des deux.
 */
import type { PoiCategory } from '../types';

export interface CorridorRadiusGroup {
  radiusM: number;
  categories: PoiCategory[];
}

const DEFAULT_MAX_GROUPS = 3;

export function groupCategoriesByRadius(
  categories: readonly PoiCategory[],
  radiusByCategory: Partial<Record<PoiCategory, number>> | null | undefined,
  fallbackRadiusM: number,
  maxGroups: number = DEFAULT_MAX_GROUPS,
): CorridorRadiusGroup[] {
  const byRadius = new Map<number, PoiCategory[]>();
  for (const category of categories) {
    const own = radiusByCategory?.[category];
    const radiusM = own != null && Number.isFinite(own) && own > 0 ? own : fallbackRadiusM;
    const group = byRadius.get(radiusM);
    if (group) group.push(category);
    else byRadius.set(radiusM, [category]);
  }
  const groups = [...byRadius.entries()]
    .map(([radiusM, cats]) => ({ radiusM, categories: cats }))
    .sort((a, b) => a.radiusM - b.radiusM);

  const limit = Math.max(1, maxGroups);
  while (groups.length > limit) {
    // Les deux rayons voisins les plus proches (en rapport) : le moins de
    // surface ajoutée à la plus petite des deux requêtes.
    let best = 0;
    for (let i = 1; i < groups.length - 1; i++) {
      if (groups[i + 1].radiusM / groups[i].radiusM < groups[best + 1].radiusM / groups[best].radiusM) best = i;
    }
    const [low, high] = [groups[best], groups[best + 1]];
    groups.splice(best, 2, { radiusM: high.radiusM, categories: [...low.categories, ...high.categories] });
  }
  return groups;
}
