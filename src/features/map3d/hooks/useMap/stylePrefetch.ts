import { MAPBOX_TOKEN } from '../../lib/mapbox.config';
import {
  applyBasemapTheme,
  getBaseStyleUrl,
  isRedviewThemedStyleUrl,
} from '../../lib/basemapThemes';

export type MapboxStyleDefinition = Record<string, unknown>;

export const prefetchedStyleCache = new Map<string, MapboxStyleDefinition>();

const STYLE_PREFETCH_TIMEOUT_MS = 6000;
/** Second, unhurried attempt for a RedView theme (see `resolveStyleInput`). */
export const THEMED_STYLE_RETRY_TIMEOUT_MS = 20000;

export function createEmptyBootstrapStyle(): MapboxStyleDefinition {
  return { version: 8, sources: {}, layers: [] };
}

function getMapboxStyleApiUrl(styleUrl: string): string | null {
  const prefix = 'mapbox://styles/';
  if (!styleUrl.startsWith(prefix)) return null;
  const stylePath = styleUrl.slice(prefix.length);
  return `https://api.mapbox.com/styles/v1/${stylePath}?access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;
}

function cloneStyleDefinition(style: MapboxStyleDefinition): MapboxStyleDefinition {
  if (typeof structuredClone === 'function') {
    return structuredClone(style) as MapboxStyleDefinition;
  }
  return JSON.parse(JSON.stringify(style)) as MapboxStyleDefinition;
}

export function shouldPrefetchMapboxStyle(styleUrl: string): boolean {
  // RedView themes only exist as a recoloured JSON definition.
  if (isRedviewThemedStyleUrl(styleUrl)) return true;
  const apiUrl = getMapboxStyleApiUrl(styleUrl);
  if (!apiUrl) return false;
  if (
    styleUrl === 'mapbox://styles/mapbox/standard'
    || styleUrl === 'mapbox://styles/mapbox/standard-satellite'
  ) {
    return false;
  }
  return true;
}

async function fetchMapboxStyleDefinition(
  styleUrl: string,
  timeoutMs = STYLE_PREFETCH_TIMEOUT_MS,
): Promise<MapboxStyleDefinition> {
  const cached = prefetchedStyleCache.get(styleUrl);
  if (cached) return cloneStyleDefinition(cached);

  if (isRedviewThemedStyleUrl(styleUrl)) {
    const baseStyle = await fetchMapboxStyleDefinition(getBaseStyleUrl(styleUrl), timeoutMs);
    const themed = applyBasemapTheme(styleUrl, baseStyle);
    prefetchedStyleCache.set(styleUrl, themed);
    return cloneStyleDefinition(themed);
  }

  const apiUrl = getMapboxStyleApiUrl(styleUrl);
  if (!apiUrl) throw new Error(`Unsupported style URL: ${styleUrl}`);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'default',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching style ${styleUrl}`);
    }
    const style = (await response.json()) as MapboxStyleDefinition;
    prefetchedStyleCache.set(styleUrl, style);
    return cloneStyleDefinition(style);
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * Résout le style Mapbox soit sous forme d'objet JSON préchargé, soit en URL brute.
 *
 * Un thème RedView n'existe que recoloré : son URL de base afficherait l'Outdoors
 * clair d'origine sous le thème sombre, et Mapbox retéléchargerait ce même style.
 * Il a donc droit à un second essai sans hâte avant ce repli.
 */
export async function resolveStyleInput(styleUrl: string): Promise<string | MapboxStyleDefinition> {
  if (!shouldPrefetchMapboxStyle(styleUrl)) return styleUrl;
  try {
    return await fetchMapboxStyleDefinition(styleUrl);
  } catch (error) {
    if (isRedviewThemedStyleUrl(styleUrl)) {
      console.warn('[map3d] themed style prefetch failed, retrying', error);
      try {
        return await fetchMapboxStyleDefinition(styleUrl, THEMED_STYLE_RETRY_TIMEOUT_MS);
      } catch (retryError) {
        console.warn('[map3d] themed style unavailable, falling back to its untouched base style', retryError);
        return getBaseStyleUrl(styleUrl);
      }
    }
    console.warn('[map3d] style prefetch failed, falling back to URL', error);
    return getBaseStyleUrl(styleUrl);
  }
}

/**
 * Synchronous variant for recovery paths that cannot await: the cached (and
 * themed) definition when available, otherwise a URL Mapbox can load itself
 * (a RedView theme then degrades to its untouched base style).
 */
export function resolveStyleInputSync(styleUrl: string): string | MapboxStyleDefinition {
  const cached = prefetchedStyleCache.get(styleUrl);
  if (cached) return cloneStyleDefinition(cached);
  return getBaseStyleUrl(styleUrl);
}
