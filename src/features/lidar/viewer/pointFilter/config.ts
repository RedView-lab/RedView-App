import type { PointFilterCategoryConfig, PointFilterCategoryId, PointFilterCategoryVisibility } from './types';

export const POINT_FILTER_CATEGORIES: readonly PointFilterCategoryConfig[] = [
  {
    id: 'ground',
    label: 'Sol',
    classCodes: [2],
    defaultVisible: true,
  },
  {
    id: 'vegetationHigh',
    label: 'Végétation haute',
    classCodes: [5],
    defaultVisible: true,
  },
  {
    id: 'vegetationMedium',
    label: 'Végétation moyenne',
    classCodes: [4],
    defaultVisible: true,
  },
  {
    id: 'vegetationLow',
    label: 'Végétation basse',
    classCodes: [3],
    defaultVisible: true,
  },
  {
    id: 'buildings',
    label: 'Bâtiments',
    classCodes: [6, 65],
    defaultVisible: true,
  },
  {
    id: 'water',
    label: 'Eau',
    classCodes: [9, 67],
    defaultVisible: true,
  },
  {
    id: 'bridges',
    label: 'Ponts',
    classCodes: [17, 66],
    defaultVisible: true,
  },
  {
    id: 'unclassified',
    label: 'Non classé',
    classCodes: [0, 1, 64, 8],
    defaultVisible: true,
  },
  {
    id: 'noise',
    label: 'Bruit',
    classCodes: [7, 18],
    defaultVisible: true,
  },
] as const;

export const POINT_FILTER_COLUMN_A: readonly PointFilterCategoryId[] = [
  'ground',
  'vegetationHigh',
  'vegetationMedium',
  'vegetationLow',
] as const;

export const POINT_FILTER_COLUMN_B: readonly PointFilterCategoryId[] = [
  'buildings',
  'water',
  'bridges',
  'unclassified',
  'noise',
] as const;

export function getDefaultPointFilterCategories(): PointFilterCategoryVisibility {
  return {
    ground: true,
    vegetationHigh: true,
    vegetationMedium: true,
    vegetationLow: true,
    buildings: true,
    water: true,
    bridges: true,
    unclassified: true,
    noise: true,
  };
}

/**
 * Calcule 4 masques de 32 bits représentant les classes 0..127.
 * Bit à 1 si la classe est visible, à 0 si elle est masquée.
 */
export function computePointFilterBitmasks(
  enabled: boolean,
  categories: PointFilterCategoryVisibility,
): [number, number, number, number] {
  if (!enabled) {
    // Toutes les classes 0..127 activées (tous les bits à 1)
    return [0xffffffff >>> 0, 0xffffffff >>> 0, 0xffffffff >>> 0, 0xffffffff >>> 0];
  }

  const masks: [number, number, number, number] = [0, 0, 0, 0];

  for (const cat of POINT_FILTER_CATEGORIES) {
    const isVisible = categories[cat.id] ?? true;
    if (isVisible) {
      for (const code of cat.classCodes) {
        if (code >= 0 && code < 32) {
          masks[0] = (masks[0] | (1 << code)) >>> 0;
        } else if (code >= 32 && code < 64) {
          masks[1] = (masks[1] | (1 << (code - 32))) >>> 0;
        } else if (code >= 64 && code < 96) {
          masks[2] = (masks[2] | (1 << (code - 64))) >>> 0;
        } else if (code >= 96 && code < 128) {
          masks[3] = (masks[3] | (1 << (code - 96))) >>> 0;
        }
      }
    }
  }

  return masks;
}
