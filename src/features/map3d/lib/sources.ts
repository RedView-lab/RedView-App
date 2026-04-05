import { FRANCE_BOUNDS, DEM_SOURCE_MAXZOOM } from './ign.config';

/**
 * Unified DEM source: IGN MNS 0.42m/px for France, Mapbox 30m elsewhere.
 * Processed client-side by Service Worker (sw-dem.js) intercepting /dem-tiles/ requests.
 */
export const unifiedDEMSource = {
  id: 'unified-dem',
  type: 'raster-dem' as const,
  tiles: ['/dem-tiles/{z}/{x}/{y}'],
  tileSize: 512,
  encoding: 'mapbox' as const,
  maxzoom: DEM_SOURCE_MAXZOOM,
};

/**
 * IGN Orthophoto source — proxied through Service Worker.
 * SW clips tiles to France border polygon so areas outside France are transparent,
 * letting the Mapbox satellite base layer show through at borders.
 */
export const ignOrthoSource = {
  id: 'ign-ortho',
  type: 'raster' as const,
  tiles: ['/ortho-tiles/{z}/{x}/{y}'],
  tileSize: 256,
  minzoom: 6,
  maxzoom: 19,
  bounds: FRANCE_BOUNDS,
  attribution: '&copy; IGN - Géoplateforme',
};
