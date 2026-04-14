import type { LabelCategoryDef } from '../types';

// ── Label categories with Mapbox API mapping ──────────────────────────
//
// "config" categories use:
//   map.setConfigProperty('basemap', configKey, boolean)
//
// "layers" categories enumerate style layers matching the regex pattern
//   and toggle visibility via map.setLayoutProperty(id, 'visibility', …)

export const LABEL_CATEGORIES: LabelCategoryDef[] = [
  {
    id: 'poi',
    label: 'POI Labels',
    defaultEnabled: true,
    mapping: { type: 'config', configKey: 'showPointOfInterestLabels' },
  },
  {
    id: 'roads',
    label: 'Routes',
    defaultEnabled: true,
    mapping: { type: 'config', configKey: 'showRoadLabels' },
  },
  {
    id: 'places',
    label: 'Villes & Lieux',
    defaultEnabled: true,
    mapping: { type: 'config', configKey: 'showPlaceLabels' },
  },
  {
    id: 'naturalParks',
    label: 'Parcs Naturels',
    defaultEnabled: false,
    mapping: { type: 'layers', pattern: /natural|park|protected/i },
  },
  {
    id: 'countries',
    label: 'Frontières',
    defaultEnabled: false,
    mapping: { type: 'config', configKey: 'showAdminBoundaries' },
  },
  {
    id: 'waterBody',
    label: 'Plans d\'eau',
    defaultEnabled: false,
    mapping: { type: 'layers', pattern: /water.*label|waterway.*label/i },
  },
];
