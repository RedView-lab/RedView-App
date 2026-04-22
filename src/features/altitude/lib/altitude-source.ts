import type {
  AltitudeCategory,
  AltitudeColorMode,
  AltitudeResolutionKey,
} from '../types';
import { buildAltitudeColorExpression, MAX_ALTITUDE_M } from './altitude-config';

export const ALTITUDE_SOURCE_ID = 'altitude-tiles';
export const ALTITUDE_LAYER_ID = 'altitude-overlay';

const RESOLUTION_FACTOR: Record<AltitudeResolutionKey, number> = {
  '0.40 m (LIDAR)': 1,
  '1 m': 2,
  '5 m': 8,
  '10 m': 16,
};

const ALTITUDE_DECODE_MIX: [number, number, number, number] = [1671168, 6528, 25.5, -10000];
const ALTITUDE_DECODE_RANGE: [number, number] = [0, MAX_ALTITUDE_M];

export function resolutionToFactor(resolution: AltitudeResolutionKey | undefined): number {
  if (!resolution) return 1;
  return RESOLUTION_FACTOR[resolution] ?? 1;
}

export function buildAltitudeTileSource(resolutionFactor: number = 1) {
  const resQuery = resolutionFactor > 1 ? `?res=${resolutionFactor}` : '';
  return {
    type: 'raster' as const,
    tiles: [`/altitude-tiles/{z}/{x}/{y}${resQuery}`],
    tileSize: 256,
    minzoom: 6,
    maxzoom: 17,
  };
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