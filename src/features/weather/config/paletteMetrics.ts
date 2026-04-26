import type { WeatherOverlayMetric } from '../overlay/types';

type Color = readonly [number, number, number];
type ColorStop = readonly [number, Color];

export type WeatherPaletteScaleSettingValue = '2 couleurs' | '3 couleurs' | '4 couleurs' | '6 couleurs';

export interface WeatherPaletteMetricDefinition {
  minLimit: number;
  maxLimit: number;
  step: number;
  decimals: number;
  unit: string;
  defaultBreakpoints: number[];
  defaultOpacity: number;
  defaultScaleSetting: WeatherPaletteScaleSettingValue;
  defaultBandColors: string[];
  overlayStops: readonly ColorStop[];
}

const WEATHER_PALETTE_METRICS: Record<WeatherOverlayMetric, WeatherPaletteMetricDefinition> = {
  temperature: {
    minLimit: -40,
    maxLimit: 50,
    step: 1,
    decimals: 0,
    unit: '°C',
    defaultBreakpoints: [0, 10, 20],
    defaultOpacity: 37,
    defaultScaleSetting: '4 couleurs',
    defaultBandColors: ['#2DBF8C', '#D3D820', '#FF9B00', '#FF0000'],
    overlayStops: [
      [0, [44, 108, 255]],
      [0.25, [62, 186, 255]],
      [0.5, [55, 211, 134]],
      [0.75, [255, 192, 56]],
      [1, [228, 71, 44]],
    ],
  },
  feelsLike: {
    minLimit: -40,
    maxLimit: 50,
    step: 1,
    decimals: 0,
    unit: '°C',
    defaultBreakpoints: [-5, 8, 18],
    defaultOpacity: 37,
    defaultScaleSetting: '4 couleurs',
    defaultBandColors: ['#1F6BFF', '#2DBF8C', '#FFB000', '#C5005C'],
    overlayStops: [
      [0, [31, 107, 255]],
      [0.32, [45, 191, 140]],
      [0.66, [255, 176, 0]],
      [1, [197, 0, 92]],
    ],
  },
  rain: {
    minLimit: 0,
    maxLimit: 20,
    step: 0.1,
    decimals: 1,
    unit: 'mm',
    defaultBreakpoints: [0.5, 2, 6],
    defaultOpacity: 42,
    defaultScaleSetting: '4 couleurs',
    defaultBandColors: ['#DFF6FF', '#66C7F4', '#2F80ED', '#1247B9'],
    overlayStops: [
      [0, [74, 122, 255]],
      [0.4, [71, 201, 255]],
      [0.7, [52, 232, 171]],
      [1, [18, 145, 255]],
    ],
  },
  cloudCover: {
    minLimit: 0,
    maxLimit: 100,
    step: 1,
    decimals: 0,
    unit: '%',
    defaultBreakpoints: [25, 50, 75],
    defaultOpacity: 34,
    defaultScaleSetting: '4 couleurs',
    defaultBandColors: ['#FFFFFF', '#D2D9E2', '#8E99AA', '#566173'],
    overlayStops: [
      [0, [255, 255, 255]],
      [0.45, [207, 216, 226]],
      [1, [103, 114, 128]],
    ],
  },
  humidity: {
    minLimit: 0,
    maxLimit: 100,
    step: 1,
    decimals: 0,
    unit: '%',
    defaultBreakpoints: [25, 50, 75],
    defaultOpacity: 35,
    defaultScaleSetting: '4 couleurs',
    defaultBandColors: ['#F6B74A', '#B4D66B', '#4AB5A8', '#2B73E0'],
    overlayStops: [
      [0, [246, 183, 74]],
      [0.4, [135, 212, 132]],
      [1, [53, 150, 255]],
    ],
  },
};

export function getWeatherPaletteMetricDefinition(key: string): WeatherPaletteMetricDefinition | null {
  return WEATHER_PALETTE_METRICS[key as WeatherOverlayMetric] ?? null;
}

export function getWeatherOverlayColorStops(metric: WeatherOverlayMetric): readonly ColorStop[] {
  return WEATHER_PALETTE_METRICS[metric].overlayStops;
}