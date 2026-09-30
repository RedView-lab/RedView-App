import { applyBasemapPalette } from './engine';
import { TOPO_DARK_PALETTE, TOPO_LIGHT_PALETTE } from './palettes';
import type { BasemapPalette, BasemapTone } from './types';
import {
  REDVIEW_TOPO_DARK_STYLE_URL,
  REDVIEW_TOPO_LIGHT_STYLE_URL,
  isRedviewThemedStyleUrl,
} from './urls';

export {
  REDVIEW_TOPO_DARK_STYLE_URL,
  REDVIEW_TOPO_LIGHT_STYLE_URL,
  isRedviewThemedStyleUrl,
};
export type { BasemapPalette, BasemapTone };

interface BasemapTheme {
  /** Real Mapbox style the theme recolours (fetched through the Styles API). */
  baseStyleUrl: string;
  palette: BasemapPalette;
}

// Outdoors carries everything a route planner needs (vector hillshade,
// cycleways, trails, peaks) and is already the "Topographique"
// basemap: same tilesets, same billing, no custom Styles API upload.
const OUTDOORS_V12 = 'mapbox://styles/mapbox/outdoors-v12';

const THEMES: Record<string, BasemapTheme> = {
  [REDVIEW_TOPO_LIGHT_STYLE_URL]: { baseStyleUrl: OUTDOORS_V12, palette: TOPO_LIGHT_PALETTE },
  [REDVIEW_TOPO_DARK_STYLE_URL]: { baseStyleUrl: OUTDOORS_V12, palette: TOPO_DARK_PALETTE },
};

function getTheme(styleUrl: string): BasemapTheme | null {
  return isRedviewThemedStyleUrl(styleUrl) ? (THEMES[styleUrl] ?? null) : null;
}

/** Mapbox style a (possibly virtual) style URL is rendered from. */
export function getBaseStyleUrl(styleUrl: string): string {
  return getTheme(styleUrl)?.baseStyleUrl ?? styleUrl;
}

/**
 * Applies the RedView theme of `styleUrl` to a fetched base style definition
 * (mutates and returns it). Non-themed URLs return the definition untouched.
 */
export function applyBasemapTheme<T extends Record<string, unknown>>(styleUrl: string, style: T): T {
  const theme = getTheme(styleUrl);
  if (!theme) return style;
  return applyBasemapPalette(style, theme.palette) as T;
}
