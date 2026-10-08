// ── Catégories d'étiquettes pour basculer les étiquettes de la carte ──

export type LabelCategory =
  | 'poi'
  | 'roads'
  | 'places'
  | 'states'
  | 'naturalParks'
  | 'countries'
  | 'waterBody';

// ── Correspondance d'une catégorie avec l'API Mapbox ──────────────────

type LabelCategoryKind =
  | { type: 'config'; configKey: string | string[] }
  | { type: 'layers'; pattern: RegExp }
  | {
      type: 'mixed';
      configKey: string | string[];
      pattern: RegExp;
    };

export interface LabelCategoryDef {
  id: LabelCategory;
  label: string;
  defaultEnabled: boolean;
  mapping: LabelCategoryKind;
}
