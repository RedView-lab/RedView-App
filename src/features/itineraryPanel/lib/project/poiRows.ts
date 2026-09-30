import type { PoiCategory } from '../../types';

/**
 * Lignes POI exposées dans l'app (panneau POI, grille des pauses par POI), dans
 * l'ordre d'affichage. Source unique : ajouter / retirer une ligne ici suffit
 * côté UI.
 */
export const PANEL_POI_ROWS: ReadonlyArray<{ key: PoiCategory; label: string }> = [
  { key: 'fountains', label: 'Fontaines' },
  { key: 'toilets', label: 'Toilettes' },
  { key: 'supermarkets', label: 'Supermarchés' },
  { key: 'gasStations', label: 'Station Service' },
  { key: 'bakeries', label: 'Boulangerie' },
  { key: 'fastFood', label: 'Fast-food' },
  { key: 'cafes', label: 'Café' },
  { key: 'bars', label: 'Bar' },
  { key: 'restaurants', label: 'Restaurant' },
  { key: 'bikeShops', label: 'Magasin de vélo' },
  { key: 'hotels', label: 'Hôtels' },
  { key: 'refuges', label: 'Refuges' },
  { key: 'health', label: 'Santé' },
  { key: 'passes', label: 'Col' },
];

/**
 * Catégories retirées de l'UI (pour le moment) mais conservées dans le type et
 * la persistance : les projets existants restent chargeables et leurs favoris
 * déjà classés gardent leur ligne de timeline. Elles ne sont plus jamais
 * recherchées, même si un ancien projet les a laissées cochées.
 */
export const HIDDEN_PANEL_POI_CATEGORIES: ReadonlySet<PoiCategory> = new Set<PoiCategory>(['transport']);

export function isPanelPoiCategoryHidden(category: string): boolean {
  return HIDDEN_PANEL_POI_CATEGORIES.has(category as PoiCategory);
}
