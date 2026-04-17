// IGN orthophoto overlay. Uses the default Standard-Satellite slot (middle)
// so the 20 cm IGN imagery renders ABOVE the base satellite, not below it.
// 'slot: "bottom"' hides the layer entirely under Standard-Satellite.
export const ignOrthoLayer = {
  id: 'ign-ortho-layer',
  type: 'raster' as const,
  source: 'ign-ortho',
  slot: 'top',
  minzoom: 6,
  paint: {
    'raster-opacity': 1,
    'raster-fade-duration': 0,
  },
  layout: {
    visibility: 'visible' as const,
  },
};
