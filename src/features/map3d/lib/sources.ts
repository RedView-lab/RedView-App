import { FRANCE_BOUNDS, DEM_SOURCE_MAXZOOM } from './ign.config';
import { getOrthoTileTemplate } from './ign.utils';

export const unifiedDEMSource = {
  id: 'unified-dem',
  type: 'raster-dem' as const,
  tiles: ['igndem://{z}/{x}/{y}'],
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
