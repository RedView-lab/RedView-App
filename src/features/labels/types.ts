import type { Map as MapboxMap } from 'mapbox-gl';

// ── Label categories for toggling map labels ──────────────────────────

export const LABEL_CATEGORIES = [
  'poi',
  'roads',
  'places',
  'naturalParks',
  'countries',
  'waterBody',
] as const;

export type LabelCategory = (typeof LABEL_CATEGORIES)[number];

// ── How a category maps to the Mapbox API ─────────────────────────────

export type LabelCategoryKind =
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

// ── Component props ───────────────────────────────────────────────────

export interface LabelsPanelProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
}
