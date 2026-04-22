import type { WeatherLayerKey, WeatherPaletteBand, WeatherPaletteScaleSetting } from './types';

interface WeatherPaletteMetricSpec {
  minLimit: number;
  maxLimit: number;
  step: number;
  decimals: number;
  unit: string;
  defaultBreakpoints: number[];
}

const WEATHER_PALETTE_SPECS: Partial<Record<WeatherLayerKey, WeatherPaletteMetricSpec>> = {
  temperature: {
    minLimit: -40,
    maxLimit: 50,
    step: 1,
    decimals: 0,
    unit: '°C',
    defaultBreakpoints: [0, 10, 20],
  },
  feelsLike: {
    minLimit: -40,
    maxLimit: 50,
    step: 1,
    decimals: 0,
    unit: '°C',
    defaultBreakpoints: [0, 10, 20],
  },
  rain: {
    minLimit: 0,
    maxLimit: 20,
    step: 0.1,
    decimals: 1,
    unit: 'mm',
    defaultBreakpoints: [0.5, 2, 6],
  },
  cloudCover: {
    minLimit: 0,
    maxLimit: 100,
    step: 1,
    decimals: 0,
    unit: '%',
    defaultBreakpoints: [25, 50, 75],
  },
  humidity: {
    minLimit: 0,
    maxLimit: 100,
    step: 1,
    decimals: 0,
    unit: '%',
    defaultBreakpoints: [25, 50, 75],
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(left: number, right: number, ratio: number): number {
  return left + (right - left) * ratio;
}

function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const rounded = Math.round(value / step) * step;
  const decimals = step >= 1 ? 0 : Math.max(0, `${step}`.split('.')[1]?.length ?? 0);
  return Number(rounded.toFixed(decimals));
}

function formatValue(value: number, decimals: number): string {
  if (decimals <= 0) return `${Math.round(value)}`;
  return value.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
}

function interpolatePoints(points: number[], ratio: number): number {
  const position = clamp(ratio, 0, 1) * Math.max(0, points.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.min(points.length - 1, lowerIndex + 1);
  const localRatio = position - lowerIndex;
  return lerp(points[lowerIndex] ?? 0, points[upperIndex] ?? 0, localRatio);
}

function defaultBreakpointsForCount(spec: WeatherPaletteMetricSpec, bandCount: number): number[] {
  const count = Math.max(0, bandCount - 1);
  const base = [spec.minLimit, ...spec.defaultBreakpoints, spec.maxLimit];
  return Array.from({ length: count }, (_, index) => roundToStep(
    interpolatePoints(base, (index + 1) / bandCount),
    spec.step,
  ));
}

function paletteColorsForCount(bands: WeatherPaletteBand[], count: number): string[] {
  if (!bands.length) return Array.from({ length: count }, () => '#FFFFFF');
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.min(
      bands.length - 1,
      Math.round((index / Math.max(1, count - 1)) * Math.max(0, bands.length - 1)),
    );
    return bands[sourceIndex]?.color ?? bands[bands.length - 1]?.color ?? '#FFFFFF';
  });
}

function extractBreakpoints(bands: WeatherPaletteBand[]): number[] | null {
  if (!bands.length) return null;
  const breakpoints = bands.slice(0, -1).map((band) => band.maxValue);
  return breakpoints.every((value) => Number.isFinite(value)) ? breakpoints : null;
}

export function weatherPaletteMetricSpec(key: WeatherLayerKey): WeatherPaletteMetricSpec | null {
  return WEATHER_PALETTE_SPECS[key] ?? null;
}

export function weatherPaletteScaleCount(setting: WeatherPaletteScaleSetting): number {
  const match = /^(\d+)/.exec(setting);
  return match ? Number(match[1]) : 4;
}

export function formatWeatherPaletteValue(key: WeatherLayerKey, value: number): string {
  const spec = weatherPaletteMetricSpec(key);
  if (!spec) return `${value}`;
  return formatValue(roundToStep(value, spec.step), spec.decimals);
}

export function formatWeatherPaletteBandLabel(
  key: WeatherLayerKey,
  band: WeatherPaletteBand,
  index: number,
  total: number,
): string {
  const spec = weatherPaletteMetricSpec(key);
  if (!spec) return band.label;
  const suffix = spec.unit === '°C' ? spec.unit : ` ${spec.unit}`;
  if (index === 0) return `< ${formatWeatherPaletteValue(key, band.maxValue)}${suffix}`;
  if (index === total - 1) return `> ${formatWeatherPaletteValue(key, band.minValue)}${suffix}`;
  return `${formatWeatherPaletteValue(key, band.minValue)}${suffix} - ${formatWeatherPaletteValue(key, band.maxValue)}${suffix}`;
}

export function clampWeatherPaletteBreakpoints(
  key: WeatherLayerKey,
  breakpoints: number[],
  bandCount: number,
): number[] {
  const spec = weatherPaletteMetricSpec(key);
  if (!spec) return breakpoints;

  const count = Math.max(0, bandCount - 1);
  if (count === 0) return [];

  const defaults = defaultBreakpointsForCount(spec, bandCount);
  const minGap = spec.step;
  const usableMin = spec.minLimit + minGap;
  const usableMax = spec.maxLimit - minGap;

  if (usableMin > usableMax) return defaults;

  const next = Array.from({ length: count }, (_, index) => {
    const raw = Number.isFinite(breakpoints[index]) ? breakpoints[index] : defaults[index];
    return roundToStep(clamp(raw, usableMin, usableMax), spec.step);
  });

  for (let index = 1; index < count; index += 1) {
    if (next[index] <= next[index - 1]) {
      next[index] = roundToStep(next[index - 1] + minGap, spec.step);
    }
  }

  if (next[count - 1] > usableMax) {
    next[count - 1] = usableMax;
    for (let index = count - 2; index >= 0; index -= 1) {
      const maxAllowed = roundToStep(next[index + 1] - minGap, spec.step);
      next[index] = clamp(next[index], usableMin, maxAllowed);
    }
  }

  for (let index = 1; index < count; index += 1) {
    if (next[index] <= next[index - 1]) return defaults;
  }

  return next;
}

export function buildWeatherPaletteBands(
  key: WeatherLayerKey,
  colors: string[],
  breakpoints: number[],
): WeatherPaletteBand[] {
  const spec = weatherPaletteMetricSpec(key);
  if (!spec) return [];
  const clampedBreakpoints = clampWeatherPaletteBreakpoints(key, breakpoints, colors.length);
  const stops = [spec.minLimit, ...clampedBreakpoints, spec.maxLimit];
  return colors.map((color, index) => {
    const minValue = stops[index] ?? spec.minLimit;
    const maxValue = stops[index + 1] ?? spec.maxLimit;
    const band: WeatherPaletteBand = {
      id: `${key}-${index}`,
      label: '',
      color,
      minValue,
      maxValue,
    };
    return {
      ...band,
      label: formatWeatherPaletteBandLabel(key, band, index, colors.length),
    };
  });
}

export function resampleWeatherPaletteBands(
  key: WeatherLayerKey,
  bands: WeatherPaletteBand[],
  scaleSetting: WeatherPaletteScaleSetting,
): WeatherPaletteBand[] {
  const spec = weatherPaletteMetricSpec(key);
  if (!spec) return bands;
  const count = weatherPaletteScaleCount(scaleSetting);
  const colors = paletteColorsForCount(bands, count);
  const sourceBreakpoints = extractBreakpoints(bands)
    ?? defaultBreakpointsForCount(spec, Math.max(2, bands.length || count));
  const sourcePoints = [spec.minLimit, ...sourceBreakpoints, spec.maxLimit];
  const nextBreakpoints = Array.from({ length: Math.max(0, count - 1) }, (_, index) => roundToStep(
    interpolatePoints(sourcePoints, (index + 1) / count),
    spec.step,
  ));
  return buildWeatherPaletteBands(key, colors, nextBreakpoints);
}