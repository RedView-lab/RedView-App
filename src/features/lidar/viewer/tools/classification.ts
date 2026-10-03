// ============================================
// LiDAR viewer tools — ASPRS class names
// ============================================

import { POINT_FILTER_CATEGORIES } from '../pointFilter/config';

const LABEL_BY_CLASS = new Map<number, string>();
for (const category of POINT_FILTER_CATEGORIES) {
  for (const code of category.classCodes) LABEL_BY_CLASS.set(code, category.label);
}

/** Display name (French source text) of an ASPRS class, as in the point filter. */
export function classificationLabel(classification: number): string {
  return LABEL_BY_CLASS.get(classification) ?? 'Non classé';
}
