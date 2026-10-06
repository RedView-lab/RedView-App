/**
 * Couleur CSS sans danger (hex, rgb(), hsl(), nom) : passée telle quelle à
 * Mapbox et aux styles. Ni `;`, ni `:`, ni guillemets, ni `url(`. Partagée
 * par la lecture d'un fichier `.redview` et par le serveur temps réel (couleur
 * d'un itinéraire écrite par un autre éditeur).
 */
export const SAFE_CSS_COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/-]+\)|[a-z]{3,30})$/i;

export function isSafeCssColor(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CSS_COLOR.test(value);
}
