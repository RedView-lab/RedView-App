import type {
  AltitudeCategory,
  AltitudeColorMode,
} from '../types';
import { buildAltitudeColorExpression, MAX_ALTITUDE_M } from './altitude-config';

import { DEM_SOURCE_MAXZOOM } from '@/features/map3d/lib/ign.config';

export const ALTITUDE_SOURCE_ID = 'altitude-tiles';
export const ALTITUDE_LAYER_ID = 'altitude-overlay';

const ALTITUDE_DECODE_MIX: [number, number, number, number] = [1671168, 6528, 25.5, -10000];
const ALTITUDE_DECODE_RANGE: [number, number] = [0, MAX_ALTITUDE_M];

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
}

const DEFAULT_ALTITUDE_SOURCE_OPTIONS: AltitudeTileSourceOptions = { zone: null };

export function buildAltitudeSourceKey(options: AltitudeTileSourceOptions | undefined): string {
  const resolved = options ?? DEFAULT_ALTITUDE_SOURCE_OPTIONS;
  return resolved.zone ? `zone-${resolved.zone.hash}` : 'zone-none';
}

// Zone mode mirrors the slope overlay: `bounds` stops Mapbox from requesting
// tiles outside the polygon bbox, and `?zone=<hash>` drives the Service
// Worker's early rejection + per-pixel polygon mask (see sw-dem/core/analysis-zone.js).
export function buildAltitudeTileSource(options: AltitudeTileSourceOptions = DEFAULT_ALTITUDE_SOURCE_OPTIONS) {
  const params = new URLSearchParams();
  if (options.zone) {
    params.set('zone', options.zone.hash);
  }
  const query = params.toString();
  const source: {
    type: 'raster';
    tiles: string[];
    tileSize: number;
    minzoom: number;
    maxzoom: number;
    bounds?: [number, number, number, number];
  } = {
    type: 'raster',
    tiles: [`/altitude-tiles/{z}/{x}/{y}${query ? `?${query}` : ''}`],
    tileSize: 256,
    minzoom: 4,
    maxzoom: DEM_SOURCE_MAXZOOM,
  };
  if (options.zone) {
    source.bounds = options.zone.bounds;
  }
  return source;
}

export function buildAltitudeLayer(
  opacity: number,
  colorMode: AltitudeColorMode,
  categories: AltitudeCategory[],
  hiddenIds?: ReadonlySet<string> | string[],
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
      'raster-color-mix': ALTITUDE_DECODE_MIX,
      'raster-color-range': ALTITUDE_DECODE_RANGE,
      'raster-color': buildAltitudeColorExpression(categories, colorMode, hiddenIds),
    },
  };
}

export { buildAltitudeColorExpression };