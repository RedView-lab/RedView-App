/**
 * Potabilité des points d'eau, d'après le tag OSM `drinking_water`.
 *
 * Depuis la taxonomie v4, l'importeur ne range plus un point déclaré non
 * potable dans une catégorie d'eau. Les projets enregistrés avant gardent
 * leurs POI : `isDeclaredUndrinkable` les écarte de la carte et de ce qu'une
 * nouvelle recherche enregistre (feuille de route, export vers le compteur).
 */
import type { PoiCategory, PoiFeature } from '../types';

/** Catégories qui promettent de l'eau à boire. Le cimetière n'en fait pas partie : c'est un lieu, son robinet est un bonus. */
const WATER_SOURCE_CATEGORIES: ReadonlySet<PoiCategory> = new Set<PoiCategory>([
  'drinking_water', 'water_point', 'water_tap', 'spring', 'fountain',
]);

const UNDRINKABLE = new Set(['no', 'not']);

type WaterFeature = Pick<PoiFeature, 'category' | 'tags'>;

/** Point d'eau explicitement déclaré non potable. */
export function isDeclaredUndrinkable(feature: WaterFeature): boolean {
  return WATER_SOURCE_CATEGORIES.has(feature.category) && UNDRINKABLE.has(feature.tags?.drinking_water ?? '');
}

/**
 * Note de la popup sur l'eau, ou null. Honnête plutôt que rassurante : une
 * fontaine sans tag est souvent décorative, une source rarement traitée, et
 * le robinet d'un cimetière n'est presque jamais signalé.
 */
export function poiWaterHint(feature: WaterFeature): string | null {
  const drinking = feature.tags?.drinking_water;
  if (feature.category === 'cemetery') {
    if (drinking === 'yes' || drinking === 'treated') return 'Eau potable signalée';
    if (drinking != null && UNDRINKABLE.has(drinking)) return 'Eau signalée non potable';
    return 'Robinet probable, eau non garantie potable';
  }
  if (!WATER_SOURCE_CATEGORIES.has(feature.category)) return null;
  if (drinking === 'conditional') return 'Potable sous conditions';
  if (drinking === 'untreated') return 'Eau non traitée';
  if (drinking != null && UNDRINKABLE.has(drinking)) return 'Eau signalée non potable';
  // Un point d'eau potable l'est par définition ; ailleurs, seul le tag l'affirme.
  if (feature.category === 'drinking_water') return null;
  if (drinking === 'yes' || drinking === 'treated') return 'Eau potable signalée';
  return 'Potabilité non renseignée';
}
