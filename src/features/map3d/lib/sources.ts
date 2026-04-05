import { FRANCE_BOUNDS, DEM_SOURCE_MAXZOOM } from './ign.config';
import { getOrthoTileTemplate } from './ign.utils';

/**
 * Unified DEM source: IGN MNS 0.42m/px for France, Mapbox 30m elsewhere.
 * Served via Vercel serverless function at /api/ign-dem/{z}/{x}/{y}.
 */
export const unifiedDEMSource = {
  id: 'unified-dem',
  type: 'raster-dem' as const,
  tiles: ['/api/ign-dem/{z}/{x}/{y}'],
  tileSize: 256,
  encoding: 'mapbox' as const,
  maxzoom: DEM_SOURCE_MAXZOOM,
};

export const ignOrthoSource = {
  id: 'ign-ortho',
  type: 'raster' as const,
  tiles: [getOrthoTileTemplate()],
  tileSize: 256,
  minzoom: 6,
  maxzoom: 19,
  bounds: FRANCE_BOUNDS,
  attribution: '&copy; IGN - Géoplateforme',
};
