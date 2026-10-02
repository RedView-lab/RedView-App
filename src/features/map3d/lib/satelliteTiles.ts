/**
 * Mapbox Satellite at full detail under the 3D terrain.
 *
 * With terrain on (always, 2D view included), GL JS first draws raster layers
 * into drape textures of 1024 px per 512 px proxy tile, then the textured
 * mesh onto the screen. A 256 px `mapbox.satellite` tile is upscaled 2× into
 * that texture before being shrunk again: the double resampling cost Lyon up
 * to ~20 % of its sharpness at some zooms (measured 2026-10-02: z17, z18.3,
 * z19.3), which reads as the imagery degrading on zoom-out. The `@2x` tile
 * (512 px, built from the next zoom's imagery) fills the drape texture 1:1.
 * GL JS only asks it when `devicePixelRatio >= 2`, which the app's DPR cap
 * (runtimeProfile) rarely reaches. Same tile count, same GL JS map-load
 * billing (the sku token is untouched), ~2× the satellite bytes.
 */
const SATELLITE_TILE_RE = /(\/v4\/mapbox\.satellite\/\d+\/\d+\/\d+)(\.(?:webp|jpg\d*|png\d*))(?=[?#]|$)/;

export function toRetinaSatelliteTileUrl(url: string): string {
  if (url.includes('@2x')) return url;
  return url.replace(SATELLITE_TILE_RE, '$1@2x$2');
}

/** `transformRequest` for the dashboard map. */
export function transformMapboxRequest(url: string, resourceType?: string): { url: string } {
  if (resourceType !== 'Tile') return { url };
  return { url: toRetinaSatelliteTileUrl(url) };
}
