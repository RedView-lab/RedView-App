import { FRANCE_BOUNDS } from './ign.config';
import { getOrthoTileTemplate } from './ign.utils';

export const mapboxDEMSource = {
  id: 'mapbox-dem',
  type: 'raster-dem' as const,
  url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
  tileSize: 512,
  maxzoom: 14,
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
