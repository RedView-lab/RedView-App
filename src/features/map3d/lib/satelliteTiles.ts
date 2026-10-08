/**
 * Mapbox Satellite en plein détail sous le terrain 3D.
 *
 * Avec le terrain actif (toujours, vue 2D comprise), GL JS dessine d'abord les
 * calques raster dans des textures de drapé de 1024 px par tuile proxy de
 * 512 px, puis le maillage texturé à l'écran. Une tuile `mapbox.satellite` de
 * 256 px est agrandie 2× dans cette texture avant d'être de nouveau réduite : ce
 * double rééchantillonnage faisait perdre à Lyon jusqu'à ~20 % de netteté à
 * certains zooms (mesuré le 2026-10-02 : z17, z18,3, z19,3), ce qui se lit comme
 * une imagerie qui se dégrade au dézoom. La tuile `@2x` (512 px, construite à
 * partir de l'imagerie du zoom suivant) remplit la texture de drapé en 1:1.
 * GL JS ne la demande que si `devicePixelRatio >= 2`, ce que le plafond de DPR
 * de l'app (runtimeProfile) atteint rarement. Même nombre de tuiles, même
 * facturation de chargement de carte GL JS (le jeton sku n'est pas touché),
 * ~2× les octets du satellite.
 */
const SATELLITE_TILE_RE = /(\/v4\/mapbox\.satellite\/\d+\/\d+\/\d+)(\.(?:webp|jpg\d*|png\d*))(?=[?#]|$)/;

function toRetinaSatelliteTileUrl(url: string): string {
  if (url.includes('@2x')) return url;
  return url.replace(SATELLITE_TILE_RE, '$1@2x$2');
}

/** `transformRequest` de la carte du dashboard. */
export function transformMapboxRequest(url: string, resourceType?: string): { url: string } {
  if (resourceType !== 'Tile') return { url };
  return { url: toRetinaSatelliteTileUrl(url) };
}
