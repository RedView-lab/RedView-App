/**
 * URL de style virtuelles des fonds de carte conçus pour RedView.
 *
 * Ce ne sont pas de vrais styles Mapbox : `stylePrefetch` les résout en
 * récupérant leur style de base Mapbox (`outdoors-v12`, mêmes jeux de tuiles et
 * même facturation que le fond « Topographique ») puis en le recolorant côté
 * client avec une palette RedView. Gardées dans un module sans dépendance pour
 * que le panneau de contrôle puisse les référencer sans tirer les palettes dans
 * son chunk.
 */
const REDVIEW_STYLE_URL_PREFIX = 'redview://styles/';

export const REDVIEW_TOPO_LIGHT_STYLE_URL = `${REDVIEW_STYLE_URL_PREFIX}topo-light`;
export const REDVIEW_TOPO_DARK_STYLE_URL = `${REDVIEW_STYLE_URL_PREFIX}topo-dark`;

export function isRedviewThemedStyleUrl(styleUrl: string): boolean {
  return styleUrl.startsWith(REDVIEW_STYLE_URL_PREFIX);
}
