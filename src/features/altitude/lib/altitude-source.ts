import type {
  AltitudeCategory,
  AltitudeColorMode,
} from '../types';
import { buildAltitudeColorExpression, MAX_ALTITUDE_M, MIN_ALTITUDE_M } from './altitude-config';
import { AltitudeDemSource, type AltitudeFallbackTiles } from './altitude-dem-source';

import {
  awsFastDEMSource,
  TERRAIN_ALIGNED_RASTER_TILE_SIZE,
  unifiedDEMSource,
} from '@/features/map3d/lib/sources';
import { mapboxRasterColorMix } from '@/features/map3d/lib/rasterColorMix';
import type { Dem3dQuality } from '@/features/map3d/lib/dem3dQualityBus';
import type { DemTileProfile } from '@/features/map3d/hooks/useMap/demTiles';

export const ALTITUDE_SOURCE_ID = 'altitude-tiles';
export const ALTITUDE_LAYER_ID = 'altitude-overlay';

/**
 * Zone-masked tiles are built by the Service Worker (per-pixel polygon mask)
 * from the DEM it caches: hypsometric bands gain nothing from z15-z17 there
 * and Mapbox overzooms past `maxzoom`.
 */
const ALTITUDE_ZONE_MAXZOOM = 14;

/**
 * The overlay uses exactly the tiles of the 3D terrain's DEM pyramid
 * (z = floor(zoom − 1)): every tile is a DEM tile the terrain already loaded.
 */
const ALTITUDE_TILE_SIZE = TERRAIN_ALIGNED_RASTER_TILE_SIZE;

// raster-color-mix works on 0..1 normalised channels (×255 folded in), with
// Mapbox's own RGB scaling compensated (see rasterColorMix.ts: without it,
// everything below ~29 m / ~96 m decoded under 0 and showed as sea level).
// Every altitude tile is Mapbox Terrain-RGB: -10000 + (R·65536 + G·256 + B) · 0.1
// (the shared-DEM source re-encodes Terrarium tiles).
const MAPBOX_RGB_DECODE_MIX = mapboxRasterColorMix([1671168, 6528, 25.5, -10000]);
const ALTITUDE_DECODE_RANGE: [number, number] = [MIN_ALTITUDE_M, MAX_ALTITUDE_M];

/** Zone restriction for the altitude overlay (analysis-zone polygon). */
export interface AltitudeZoneOptions {
  /** Stable hash of the polygon ring — becomes the `?zone=` cache key. */
  hash: string;
  /** [west, south, east, north] — Mapbox raster-source `bounds`. */
  bounds: [number, number, number, number];
  /** Flat [lng, lat, ...] ring coordinates for masking. */
  ring?: number[];
}

export interface AltitudeTileSourceOptions {
  zone?: AltitudeZoneOptions | null;
  /** Active 3D terrain quality — the overlay reads the SAME DEM as the terrain. */
  quality?: Dem3dQuality;
  /** Active HD DEM profile (surface 0.40 m vs bare-earth 1 m). */
  profile?: DemTileProfile;
}

interface ResolvedAltitudeSource {
  quality: Dem3dQuality;
  profile: DemTileProfile;
  zone: AltitudeZoneOptions | null;
}

function resolveAltitudeSource(options: AltitudeTileSourceOptions | undefined): ResolvedAltitudeSource {
  return {
    quality: options?.quality ?? 'fast-30m',
    profile: options?.profile === 'terrain' ? 'terrain' : 'default',
    zone: options?.zone ?? null,
  };
}

/** True when tiles go through the Service Worker (zone-masked path). */
export function altitudeUsesServiceWorker(options: AltitudeTileSourceOptions | undefined): boolean {
  return Boolean(resolveAltitudeSource(options).zone);
}

/** Changes whenever the source must be swapped (remove + re-add). */
export function buildAltitudeSourceKey(options: AltitudeTileSourceOptions | undefined): string {
  const { quality, profile, zone } = resolveAltitudeSource(options);
  return zone ? `zone:${zone.hash}:${profile}` : `dem:${quality}:${profile}`;
}

function swAltitudeTileUrl(profile: DemTileProfile, zone: AltitudeZoneOptions | null): string {
  const params = new URLSearchParams();
  if (profile === 'terrain') params.set('rv-dem-profile', 'terrain');
  if (zone) params.set('zone', zone.hash);
  const query = params.toString();
  return `/altitude-tiles/{z}/{x}/{y}${query ? `?${query}` : ''}`;
}

/**
 * - No zone (the common case): `AltitudeDemSource`, which reads the DEM tiles
 *   the 3D terrain already decoded (fast-30m AWS Terrarium or HD SW DEM) —
 *   no second download, colours land in the same frame as the relief. The
 *   tile URLs are only its fallback when the terrain does not hold a tile.
 * - Zone: `/altitude-tiles?zone=<hash>`, masked by the SW; `bounds` stops
 *   Mapbox requesting tiles outside the polygon bbox.
 */
export function buildAltitudeSource(options?: AltitudeTileSourceOptions) {
  const { quality, profile, zone } = resolveAltitudeSource(options);
  if (zone) {
    return {
      type: 'raster' as const,
      tiles: [swAltitudeTileUrl(profile, zone)],
      tileSize: ALTITUDE_TILE_SIZE,
      minzoom: unifiedDEMSource.minzoom,
      maxzoom: ALTITUDE_ZONE_MAXZOOM,
      bounds: zone.bounds,
    };
  }
  const terrainSource = quality === 'fast-30m' ? awsFastDEMSource : unifiedDEMSource;
  const fallback: AltitudeFallbackTiles = quality === 'fast-30m'
    ? { url: awsFastDEMSource.tiles[0], encoding: 'terrarium' }
    : { url: swAltitudeTileUrl(profile, null), encoding: 'mapbox' };
  return new AltitudeDemSource({
    id: ALTITUDE_SOURCE_ID,
    tileSize: ALTITUDE_TILE_SIZE,
    minzoom: terrainSource.minzoom,
    maxzoom: terrainSource.maxzoom,
    fallback,
  });
}

export function buildAltitudeLayer(
  opacity: number,
  colorMode: AltitudeColorMode,
  categories: AltitudeCategory[],
  hiddenIds: ReadonlySet<string> | string[] | undefined,
) {
  return {
    id: ALTITUDE_LAYER_ID,
    type: 'raster' as const,
    source: ALTITUDE_SOURCE_ID,
    slot: 'top',
    paint: {
      'raster-opacity': opacity,
      'raster-resampling': 'linear' as const,
      'raster-fade-duration': 0,
      'raster-color-mix': MAPBOX_RGB_DECODE_MIX,
      'raster-color-range': ALTITUDE_DECODE_RANGE,
      'raster-color': buildAltitudeColorExpression(categories, colorMode, hiddenIds),
      // Legend colours must stay exact under dusk/night scene lighting.
      'raster-emissive-strength': 1,
    },
  };
}

export { buildAltitudeColorExpression };
