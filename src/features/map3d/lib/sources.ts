import { FRANCE_BOUNDS, DEM_SOURCE_MAXZOOM } from './ign.config';

/**
 * Unified DEM source: high-res national DEM in covered regions, AWS Terrarium
 * (~30 m global) elsewhere. Processed client-side by Service Worker
 * (sw-dem.js) intercepting /dem-tiles/ requests.
 */
export const unifiedDEMSource = {
  id: 'unified-dem',
  type: 'raster-dem' as const,
  tiles: ['/dem-tiles/{z}/{x}/{y}'],
  // 256px to match the SW output (DEM_TILE_SIZE in config.js)
  tileSize: 256,
  encoding: 'mapbox' as const,
  // Below z6 the DEM contributes no visible relief at world view but the map
  // renderer would still request ~50 tiles per session for the globe mesh —
  // wasted bandwidth and wasted global-fallback DEM traffic.
  // Terrain stays disabled at world zoom; the SW also short-circuits z<4.
  minzoom: 6,
  maxzoom: DEM_SOURCE_MAXZOOM,
};

/**
 * IGN Orthophoto source — proxied through Service Worker.
 * SW clips tiles to France border polygon so areas outside France are transparent,
 * letting the Mapbox satellite base layer show through at borders.
 *
 * minzoom=11: below this (~75 m/px at France latitude) the 20 cm IGN ortho is
 * visually indistinguishable from Mapbox Standard-Satellite, while the fan-out
 * of tile requests saturates the ortho WMTS queue during fast dezoom and
 * produces the "patchwork of missing tiles" artifact. Above z11 the IGN overlay
 * kicks in smoothly (raster-fade-duration handles the crossfade — see layers.ts).
 */
export const ignOrthoSource = {
  id: 'ign-ortho',
  type: 'raster' as const,
  tiles: ['/ortho-tiles/{z}/{x}/{y}'],
  tileSize: 256,
  minzoom: 11,
  maxzoom: 19,
  bounds: FRANCE_BOUNDS,
  attribution: '&copy; IGN - Géoplateforme',
};

/**
 * AWS Open Data Terrarium fallback — used when the Service Worker is
 * unavailable (registration timeout, controller never claimed). Provides
 * ~30 m global terrain directly from AWS S3 with native `terrarium`
 * encoding that Mapbox GL v3 decodes on the GPU — no SW pipeline needed.
 *
 * The unified-dem SW path is always preferred because it composites
 * high-res IGN LiDAR over France/Switzerland. This source is the last
 * resort to avoid a completely flat map.
 */
export const awsFallbackDEMSource = {
  id: 'aws-fallback-dem',
  type: 'raster-dem' as const,
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  tileSize: 256,
  encoding: 'terrarium' as const,
  minzoom: 4,
  maxzoom: 14,  // AWS Terrarium native max is z14
};
