// Barrel for the POI feature.
//
// The visible POI UI now lives inside the left-dock Itinerary Panel
// (`features/itineraryPanel`). This module exposes the headless engine
// (Overpass client, GPX parser/loader, map layer helpers) so that other
// features can integrate POI data without owning their own map plumbing.

export { usePoi } from './hooks/usePoi';
export { parseGpxFile, sampleRoutePoints } from './lib/gpx-loader';
export {
  addGpxRoute,
  removeGpxRoute,
  fitMapToRoute,
  isGpxRouteOnMap,
} from './lib/gpx-layer';
export type {
  PoiCategory,
  PoiFeature,
  PoiGroup,
  GpxRoute,
} from './types';
export {
  POI_CATEGORIES,
  POI_GROUPS,
  POI_LABELS,
  POI_COLORS,
} from './types';
