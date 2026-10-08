import { applyBasemapPalette } from './engine';
import { TOPO_DARK_PALETTE, TOPO_LIGHT_PALETTE } from './palettes';
import type { BasemapPalette } from './types';
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
;

interface BasemapTheme {
  /** Vrai style Mapbox que le thème recolore (récupéré via la Styles API). */
  baseStyleUrl: string;
  palette: BasemapPalette;
}

// Outdoors porte tout ce dont un planificateur d'itinéraire a besoin (ombrage
// vectoriel, pistes cyclables, sentiers, sommets) et c'est déjà le fond
// « Topographique » : mêmes jeux de tuiles, même facturation, pas d'envoi de
// style personnalisé par la Styles API.
const OUTDOORS_V12 = 'mapbox://styles/mapbox/outdoors-v12';

const THEMES: Record<string, BasemapTheme> = {
  [REDVIEW_TOPO_LIGHT_STYLE_URL]: { baseStyleUrl: OUTDOORS_V12, palette: TOPO_LIGHT_PALETTE },
  [REDVIEW_TOPO_DARK_STYLE_URL]: { baseStyleUrl: OUTDOORS_V12, palette: TOPO_DARK_PALETTE },
};

function getTheme(styleUrl: string): BasemapTheme | null {
  return isRedviewThemedStyleUrl(styleUrl) ? (THEMES[styleUrl] ?? null) : null;
}

/** Style Mapbox à partir duquel une URL de style (éventuellement virtuelle) est rendue. */
export function getBaseStyleUrl(styleUrl: string): string {
  return getTheme(styleUrl)?.baseStyleUrl ?? styleUrl;
}

/**
 * Applique le thème RedView de `styleUrl` à une définition de style de base
 * récupérée (la modifie et la renvoie). Les URL sans thème renvoient la
 * définition intacte.
 */
export function applyBasemapTheme<T extends Record<string, unknown>>(styleUrl: string, style: T): T {
  const theme = getTheme(styleUrl);
  if (!theme) return style;
  return applyBasemapPalette(style, theme.palette) as T;
}
