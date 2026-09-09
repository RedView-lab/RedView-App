import type { WeatherOverlayMetric } from '@/features/weather/overlay/types';
import { getWeatherPaletteMetricDefinition } from '@/features/weather/config/paletteMetrics';

import type { WeatherPaletteConfig } from '../types';
import { buildWeatherPaletteBands } from '../lib/weatherPalette';

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

export function isLegacyTemperaturePalette(palette: WeatherPaletteConfig | undefined): boolean {
  if (!palette) return false;
  if (palette.bands.length === 4) {
    const b0 = palette.bands[0]?.maxValue;
    const b1 = palette.bands[1]?.maxValue;
    const b2 = palette.bands[2]?.maxValue;
    // Legacy [0, 10, 20] breakpoints
    if (b0 === 0 && b1 === 10 && b2 === 20) return true;
  }
  return false;
}

export function isLegacyFeelsLikePalette(palette: WeatherPaletteConfig | undefined): boolean {
  if (!palette) return false;
  if (palette.bands.length === 4) {
    const b0 = palette.bands[0]?.maxValue;
    const b1 = palette.bands[1]?.maxValue;
    const b2 = palette.bands[2]?.maxValue;
    // Legacy [0, 10, 20] or [-5, 8, 18] breakpoints
    if ((b0 === 0 && b1 === 10 && b2 === 20) || (b0 === -5 && b1 === 8 && b2 === 18)) return true;
  }
  return false;
}

export function hasLegacyFeelsLikeBreakpoints(palette: WeatherPaletteConfig | undefined): boolean {
  if (!palette || palette.bands.length !== 4) return false;
  const expectedRanges: Array<[number, number]> = [[-40, 0], [0, 10], [10, 20], [20, 50]];
  return palette.bands.every((band, index) => (
    band.minValue === expectedRanges[index][0]
    && band.maxValue === expectedRanges[index][1]
  ));
}