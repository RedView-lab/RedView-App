import { MAPBOX_TOKEN } from '../../lib/mapbox.config';

export type MapboxStyleDefinition = Record<string, unknown>;

export const prefetchedStyleCache = new Map<string, MapboxStyleDefinition>();

export const STYLE_PREFETCH_TIMEOUT_MS = 2500;

export function createEmptyBootstrapStyle(): MapboxStyleDefinition {
  return { version: 8, sources: {}, layers: [] };
}

export function getMapboxStyleApiUrl(styleUrl: string): string | null {
  const prefix = 'mapbox://styles/';
  if (!styleUrl.startsWith(prefix)) return null;
  const stylePath = styleUrl.slice(prefix.length);
  return `https://api.mapbox.com/styles/v1/${stylePath}?access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;
}

export function cloneStyleDefinition(style: MapboxStyleDefinition): MapboxStyleDefinition {
  if (typeof structuredClone === 'function') {
    return structuredClone(style) as MapboxStyleDefinition;
  }
  return JSON.parse(JSON.stringify(style)) as MapboxStyleDefinition;
}

export function shouldPrefetchMapboxStyle(styleUrl: string): boolean {
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

export async function fetchMapboxStyleDefinition(styleUrl: string): Promise<MapboxStyleDefinition> {
  const cached = prefetchedStyleCache.get(styleUrl);
  if (cached) return cloneStyleDefinition(cached);

  const apiUrl = getMapboxStyleApiUrl(styleUrl);
  if (!apiUrl) throw new Error(`Unsupported style URL: ${styleUrl}`);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), STYLE_PREFETCH_TIMEOUT_MS);
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
 */
export async function resolveStyleInput(styleUrl: string): Promise<string | MapboxStyleDefinition> {
  if (!shouldPrefetchMapboxStyle(styleUrl)) return styleUrl;
  try {
    return await fetchMapboxStyleDefinition(styleUrl);
  } catch (error) {
    console.warn('[map3d] style prefetch failed, falling back to URL', error);
    return styleUrl;
  }
}
