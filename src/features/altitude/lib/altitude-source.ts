import type {
  AltitudeCategory,
  AltitudeColorMode,
} from '../types';
import { buildAltitudeColorExpression, MAX_ALTITUDE_M, MIN_ALTITUDE_M } from './altitude-config';

import { awsFastDEMSource, unifiedDEMSource } from '@/features/map3d/lib/sources';
import type { Dem3dQuality } from '@/features/map3d/lib/dem3dQualityBus';
import type { DemTileProfile } from '@/features/map3d/hooks/useMap/demTiles';

export const ALTITUDE_SOURCE_ID = 'altitude-tiles';
export const ALTITUDE_LAYER_ID = 'altitude-overlay';

/**
 * Hypsometric bands (hundreds of metres wide) gain nothing from z15-z17 DEM
 * tiles: Mapbox overzooms past `maxzoom` with linear resampling. Capping here
 * is what keeps the overlay from asking the SW for dozens of high-zoom DEM
 * builds the 3D terrain never needed.
 */
export const ALTITUDE_MAXZOOM = 14;

/**
 * 512 logical px for 256 px images → Mapbox requests tiles one zoom level
 * lower than the display zoom: 4× fewer requests for a visually identical
 * colour ramp.
 */
const ALTITUDE_TILE_SIZE = 512;

// raster-color-mix works on 0..1 normalised channels (×255 folded in).
// Mapbox Terrain-RGB: -10000 + (R·65536 + G·256 + B) · 0.1
const MAPBOX_RGB_DECODE_MIX: [number, number, number, number] = [1671168, 6528, 25.5, -10000];
// Terrarium: R·256 + G + B/256 - 32768
const TERRARIUM_DECODE_MIX: [number, number, number, number] = [65280, 255, 255 / 256, -32768];
const ALTITUDE_DECODE_RANGE: [number, number] = [MIN_ALTITUDE_M, MAX_ALTITUDE_M];

export type AltitudeEncoding = 'mapbox' | 'terrarium';

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
  encoding: AltitudeEncoding;
  quality: Dem3dQuality;
  profile: DemTileProfile;
  zone: AltitudeZoneOptions | null;
}

function resolveAltitudeSource(options: AltitudeTileSourceOptions | undefined): ResolvedAltitudeSource {
  const zone = options?.zone ?? null;
  // Zone masking is a SW-side per-pixel operation — it needs the SW route
  // even when the terrain itself streams from AWS.
  const quality: Dem3dQuality = zone ? 'hd' : (options?.quality ?? 'fast-30m');
  const profile: DemTileProfile = options?.profile === 'terrain' ? 'terrain' : 'default';
  return {
    encoding: quality === 'fast-30m' ? 'terrarium' : 'mapbox',
    quality,
    profile,
    zone,
  };
}

export function getAltitudeEncoding(options: AltitudeTileSourceOptions | undefined): AltitudeEncoding {
  return resolveAltitudeSource(options).encoding;
}

/** Changes whenever the raster source must be swapped (remove + re-add). */
export function buildAltitudeSourceKey(options: AltitudeTileSourceOptions | undefined): string {
  const { quality, profile, zone } = resolveAltitudeSource(options);
  if (quality === 'fast-30m') return 'fast-30m';
  return `hd:${profile}:${zone ? `zone-${zone.hash}` : 'zone-none'}`;
}

/**
 * - `fast-30m`: the exact AWS Terrarium URLs the 3D terrain (`aws-fast-dem`)
 *   already fetched → browser HTTP cache hits, GPU decode, zero SW work.
 * - `hd`: `/altitude-tiles`, a read-through alias of the SW DEM cache for the
 *   active profile. `?zone=<hash>` switches the SW to its masked build path
 *   and `bounds` stops Mapbox requesting tiles outside the polygon bbox.
 */
export function buildAltitudeTileSource(options?: AltitudeTileSourceOptions) {
  const { quality, profile, zone } = resolveAltitudeSource(options);
  const source: {
    type: 'raster';
    tiles: string[];
    tileSize: number;
    minzoom: number;
    maxzoom: number;
    bounds?: [number, number, number, number];
  } = quality === 'fast-30m'
    ? {
        type: 'raster',
        tiles: awsFastDEMSource.tiles,
        tileSize: ALTITUDE_TILE_SIZE,
        minzoom: awsFastDEMSource.minzoom,
        maxzoom: Math.min(ALTITUDE_MAXZOOM, awsFastDEMSource.maxzoom),
      }
    : (() => {
        const params = new URLSearchParams();
        if (profile === 'terrain') params.set('rv-dem-profile', 'terrain');
        if (zone) params.set('zone', zone.hash);
        const query = params.toString();
        return {
          type: 'raster' as const,
          tiles: [`/altitude-tiles/{z}/{x}/{y}${query ? `?${query}` : ''}`],
          tileSize: ALTITUDE_TILE_SIZE,
          minzoom: unifiedDEMSource.minzoom,
          maxzoom: ALTITUDE_MAXZOOM,
        };
      })();
  if (zone) source.bounds = zone.bounds;
  return source;
}

export function buildAltitudeLayer(
  opacity: number,
  colorMode: AltitudeColorMode,
  categories: AltitudeCategory[],
  hiddenIds: ReadonlySet<string> | string[] | undefined,
  encoding: AltitudeEncoding,
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
      'raster-color-mix': encoding === 'terrarium' ? TERRARIUM_DECODE_MIX : MAPBOX_RGB_DECODE_MIX,
      'raster-color-range': ALTITUDE_DECODE_RANGE,
      'raster-color': buildAltitudeColorExpression(categories, colorMode, hiddenIds),
    },
  };
}

export { buildAltitudeColorExpression };
