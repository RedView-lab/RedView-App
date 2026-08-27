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
    mapping: {
      type: 'mixed',
      configKey: ['showPointOfInterestLabels', 'showTransitLabels'],
      pattern: /(poi|point[-_ ]?of[-_ ]?interest|airport|aerodrome|airfield|airstrip|heliport|terminal|gate|station|transit|rail|metro|subway|tram|ferry|bus|attraction|lodging|food|hospital|school)/i,
    },
  },
  {
    id: 'roads',
    label: 'Itinéraires',
    defaultEnabled: true,
    mapping: {
      type: 'mixed',
      configKey: ['showRoadLabels', 'showRoadsAndTransit', 'showPedestrianRoads'],
      pattern: /(road|street|highway|motorway|trunk|primary|secondary|tertiary|pedestrian|path|track|junction|shield|tunnel|bridge|traffic|railway|rail|transit|ferry|aerialway|aeroway|runway|taxiway)/i,
    },
  },
  {
    id: 'places',
    label: 'Villes',
    defaultEnabled: true,
    mapping: {
      type: 'mixed',
      configKey: 'showPlaceLabels',
      pattern: /(settlement|locality|city|town|village|hamlet|suburb|neighbou?rhood|district|place[-_](city|town|village|hamlet|suburb|neighbourhood|other|island|islet|locality))/i,
    },
  },
  {
    id: 'states',
    label: 'États / Régions',
    defaultEnabled: true,
    mapping: {
      type: 'mixed',
      configKey: 'showAdminBoundaries',
      pattern: /(state|province|admin[-_]?1)/i,
    },
  },
  {
    id: 'naturalParks',
    label: 'Parcs Naturels',
    defaultEnabled: false,
    mapping: {
      type: 'layers',
      pattern: /(natural|park|protected|national-park)/i,
    },
  },
  {
    id: 'countries',
    label: 'Pays',
    defaultEnabled: true,
    mapping: {
      type: 'mixed',
      configKey: 'showAdminBoundaries',
      pattern: /(country|admin[-_]?0|boundary[-_]?(land|water)|border|disputed)/i,
    },
  },
  {
    id: 'waterBody',
    label: 'Plans d\'eau',
    defaultEnabled: false,
    mapping: {
      type: 'layers',
      pattern: /(water.*label|waterway.*label|marine.*label|water-point-label|water-line-label)/i,
    },
  },
];
