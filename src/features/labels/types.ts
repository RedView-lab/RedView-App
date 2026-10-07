// ── Label categories for toggling map labels ──────────────────────────

export type LabelCategory =
  | 'poi'
  | 'roads'
  | 'places'
  | 'states'
  | 'naturalParks'
  | 'countries'
  | 'waterBody';

// ── How a category maps to the Mapbox API ─────────────────────────────

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
