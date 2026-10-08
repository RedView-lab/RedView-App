/**
 * `raster-color-mix` tel que Mapbox GL l'applique réellement.
 *
 * Mapbox GL JS (vérifié sur 3.21, `adjustColorMix` / `COLOR_MIX_FACTOR` dans le
 * peintre raster) multiplie les termes R, G, B du mélange — mais pas son
 * décalage — par (R² − 1) / (R · (R + 3)) avec R = 1024, la résolution de la
 * rampe de couleurs raster : ≈ 0,99708, soit −0,29 %.
 *
 * Invisible sur un mélange de luminance, mais un décodage de DEM est une grande
 * somme moins un grand décalage : le Terrain-RGB décode (h + 10 000) − 10 000, le
 * Terrarium (h + 32 768) − 32 768. Multiplié par 0,99708, cela donne h − 29 m et
 * h − 96 m : chaque pixel sous ~29 m (HD) ou ~96 m (30 m) tombait sous 0, dans la
 * classe transparente « mer » de l'overlay d'altitude — la Loire, le bassin
 * parisien et la majeure partie de la Bretagne apparaissaient au niveau de la mer.
 *
 * Passer le décodage exact pour des canaux 0..1 ; les termes RGB sont divisés par
 * le facteur pour que le shader le retrouve. Revérifier `COLOR_MIX_FACTOR` dans
 * node_modules/mapbox-gl/dist/mapbox-gl-dev.js à chaque montée de version de mapbox-gl.
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
