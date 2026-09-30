/**
 * Virtual style URLs for the RedView-designed basemaps.
 *
 * They are not real Mapbox styles: `stylePrefetch` resolves them by fetching
 * their Mapbox base style (`outdoors-v12`, same tilesets and billing as the
 * "Topographique" basemap) and recolouring it client-side with a RedView
 * palette. Kept in a dependency-free module so the control panel can reference
 * them without pulling the palettes into its chunk.
 */
export const REDVIEW_STYLE_URL_PREFIX = 'redview://styles/';

export const REDVIEW_TOPO_LIGHT_STYLE_URL = `${REDVIEW_STYLE_URL_PREFIX}topo-light`;
export const REDVIEW_TOPO_DARK_STYLE_URL = `${REDVIEW_STYLE_URL_PREFIX}topo-dark`;

export function isRedviewThemedStyleUrl(styleUrl: string): boolean {
  return styleUrl.startsWith(REDVIEW_STYLE_URL_PREFIX);
}
