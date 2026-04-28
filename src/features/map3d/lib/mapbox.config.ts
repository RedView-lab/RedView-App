export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

// Default style aligns with DEFAULT_BASEMAP_ID in features/controlPanel/basemaps.
// Outdoors (vector) is billed under Vector Tiles, NOT Raster Tiles, so the
// default-app load no longer charges the Raster Tiles SKU. Satellite remains
// available as a premium-tier basemap option.
export const MAPBOX_STYLE = 'mapbox://styles/mapbox/outdoors-v12';

export const DEFAULT_VIEW = {
  center: [2.3522, 46.6034] as [number, number],
  zoom: 5.5,
  pitch: 60,
  bearing: 0,
  projection: 'globe' as const,
};

export const FOG_CONFIG = {
  range: [2, 20],
  color: 'rgb(225, 235, 245)',
  'high-color': 'rgb(90, 150, 230)',
  'horizon-blend': 0.02,
  'space-color': 'rgb(11, 11, 25)',
  'star-intensity': 0.5,
};
