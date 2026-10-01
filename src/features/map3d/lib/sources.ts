import { FRANCE_BOUNDS, DEM_SOURCE_MAXZOOM } from './ign.config';

/**
 * Logical tile size that makes a raster overlay request exactly the tiles of
 * the 3D terrain's DEM pyramid.
 *
 * Mapbox loads terrain DEM tiles at `floor(zoom − 1)` for our 256 px
 * raster-dem sources (Terrain.getScaledDemTileSize(): 256 / GRID_DIM 128 ×
 * 512 px proxy tile = 1024), while a raster source asks
 * `round(zoom + log2(512 / tileSize))` — `round(zoom + 1)` for 256 px tiles,
 * i.e. 2–3 levels deeper than the terrain: 16–64× more DEM tiles to build
 * than the relief on screen. With 512·2^1.5 px the overlay asks
 * `round(zoom − 1.5) = floor(zoom − 1)`: the very tiles the terrain loaded.
 */
export const TERRAIN_ALIGNED_RASTER_TILE_SIZE = 512 * 2 * Math.SQRT2;

/** Zoom of the DEM tiles Mapbox loads for the 3D terrain at `zoom` (see above). */
export function terrainDemTileZoom(zoom: number): number {
  return Math.max(0, Math.floor(zoom - 1));
}

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

/**
 * AWS Open Data Terrarium "fast" mode — opt-in via the 3D quality selector
 * ("30 m (Rapide)"). Identical raster-dem pipeline as awsFallbackDEMSource
 * but registered under its own source id so it can coexist with the unified
 * SW pipeline. Lets the user instantly swap to a global, GPU-decoded DEM
 * that does NOT depend on the Service Worker or IGN — perfectly smooth
 * transitions, no tile-build latency, lower bandwidth than IGN LiDAR.
 */
export const awsFastDEMSource = {
  id: 'aws-fast-dem',
  type: 'raster-dem' as const,
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  tileSize: 256,
  encoding: 'terrarium' as const,
  minzoom: 4,
  maxzoom: 14,
};
