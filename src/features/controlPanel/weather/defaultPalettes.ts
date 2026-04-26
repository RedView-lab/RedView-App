import type { WeatherOverlayMetric } from '@/features/weather/overlay/types';
import { getWeatherPaletteMetricDefinition } from '@/features/weather/config/paletteMetrics';

import type { WeatherPaletteConfig } from '../types';
import { buildWeatherPaletteBands } from '../weatherPalette';

const DEFAULT_WEATHER_PALETTE_KEYS: WeatherOverlayMetric[] = [
  'temperature',
  'feelsLike',
  'rain',
  'cloudCover',
  'humidity',
];

export function buildDefaultWeatherPalettePresets(): Record<string, WeatherPaletteConfig> {
  return Object.fromEntries(
    DEFAULT_WEATHER_PALETTE_KEYS.map((key) => {
      const spec = getWeatherPaletteMetricDefinition(key);
      if (!spec) {
        throw new Error(`Missing weather palette definition for ${key}`);
      }
      return [
        key,
        {
          opacity: spec.defaultOpacity,
          scaleSetting: spec.defaultScaleSetting,
          bands: buildWeatherPaletteBands(key, spec.defaultBandColors, spec.defaultBreakpoints),
        },
      ] satisfies [string, WeatherPaletteConfig];
    }),
  );
}

export function isLegacyFeelsLikePalette(palette: WeatherPaletteConfig | undefined): boolean {
  if (!palette) return false;
  if (palette.opacity !== 37 || palette.scaleSetting !== '4 couleurs' || palette.bands.length !== 4) return false;
  const expectedColors = ['#2DBF8C', '#D3D820', '#FF9B00', '#FF0000'];
  const expectedRanges: Array<[number, number]> = [[-40, 0], [0, 10], [10, 20], [20, 50]];
  return palette.bands.every((band, index) => (
    band.color.toUpperCase() === expectedColors[index]
    && band.minValue === expectedRanges[index][0]
    && band.maxValue === expectedRanges[index][1]
  ));
}

export function hasLegacyFeelsLikeBreakpoints(palette: WeatherPaletteConfig | undefined): boolean {
  if (!palette || palette.bands.length !== 4) return false;
  const expectedRanges: Array<[number, number]> = [[-40, 0], [0, 10], [10, 20], [20, 50]];
  return palette.bands.every((band, index) => (
    band.minValue === expectedRanges[index][0]
    && band.maxValue === expectedRanges[index][1]
  ));
}