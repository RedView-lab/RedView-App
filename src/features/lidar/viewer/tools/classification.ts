// ============================================
// Outils du viewer LiDAR — noms des classes ASPRS
// ============================================

import { POINT_FILTER_CATEGORIES } from '../pointFilter/config';

const LABEL_BY_CLASS = new Map<number, string>();
for (const category of POINT_FILTER_CATEGORIES) {
  for (const code of category.classCodes) LABEL_BY_CLASS.set(code, category.label);
}

/** Nom affiché (texte source français) d'une classe ASPRS, comme dans le filtre de points. */
export function classificationLabel(classification: number): string {
  return LABEL_BY_CLASS.get(classification) ?? 'Non classé';
}
