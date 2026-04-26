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