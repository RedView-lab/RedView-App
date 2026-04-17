// IGN orthophoto overlay. Uses the default Standard-Satellite slot (middle)
// so the 20 cm IGN imagery renders ABOVE the base satellite, not below it.
// 'slot: "bottom"' hides the layer entirely under Standard-Satellite.
export const ignOrthoLayer = {
  id: 'ign-ortho-layer',
  type: 'raster' as const,
  source: 'ign-ortho',
  slot: 'top',
  minzoom: 9,
  paint: {
    'raster-opacity': 1,
    // Crossfade from parent to child tile over 250 ms. With 0 ms (previous
    // setting) a pending tile fetch produced an instant white hole; with
    // 250 ms Mapbox GL holds the blurry-but-valid parent visible until the
    // sharp child arrives, eliminating the "patchwork of missing tiles"
    // dezoom artifact without any perceptible sharpness loss.
    'raster-fade-duration': 250,
    // Smooth bilinear upscaling of the overzoomed parent while the child
    // fetch is pending — prevents pixelation during the fade window.
    'raster-resampling': 'linear' as const,
  },
  layout: {
    visibility: 'visible' as const,
  },
};
