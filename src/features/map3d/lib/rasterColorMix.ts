/**
 * `raster-color-mix` as Mapbox GL actually applies it.
 *
 * Mapbox GL JS (checked on 3.21, `adjustColorMix` / `COLOR_MIX_FACTOR` in
 * the raster painter) scales the R, G, B terms of the mix — but not its
 * offset — by (R² − 1) / (R · (R + 3)) with R = 1024, the raster colour-ramp
 * resolution: ≈ 0.99708, i.e. −0.29 %.
 *
 * Invisible on a luminance mix, but a DEM decode is a large sum minus a large
 * offset: Terrain-RGB decodes (h + 10 000) − 10 000, Terrarium
 * (h + 32 768) − 32 768. Scaled by 0.99708 that is h − 29 m and h − 96 m:
 * every pixel below ~29 m (HD) or ~96 m (30 m) landed under 0, in the
 * transparent "sea" bin of the altitude overlay — the Loire, the Paris basin
 * and most of Brittany showed as sea level.
 *
 * Pass the exact decode for 0..1 channels; the RGB terms are divided by the
 * factor so the shader recovers it. Re-check `COLOR_MIX_FACTOR` in
 * node_modules/mapbox-gl/dist/mapbox-gl-dev.js when upgrading mapbox-gl.
 */
const MAPBOX_COLOR_RAMP_RES = 1024;
const MAPBOX_COLOR_MIX_SCALE =
  (MAPBOX_COLOR_RAMP_RES ** 2 - 1) / (MAPBOX_COLOR_RAMP_RES * (MAPBOX_COLOR_RAMP_RES + 3));

export function mapboxRasterColorMix(
  [r, g, b, offset]: readonly [number, number, number, number],
): [number, number, number, number] {
  return [
    r / MAPBOX_COLOR_MIX_SCALE,
    g / MAPBOX_COLOR_MIX_SCALE,
    b / MAPBOX_COLOR_MIX_SCALE,
    offset,
  ];
}
