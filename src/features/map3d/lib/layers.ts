export const ignOrthoLayer = {
  id: 'ign-ortho-layer',
  type: 'raster' as const,
  source: 'ign-ortho',
  slot: 'bottom',
  minzoom: 6,
  paint: {
    'raster-opacity': 1,
    'raster-fade-duration': 0,
  },
  layout: {
    visibility: 'visible' as const,
  },
};
