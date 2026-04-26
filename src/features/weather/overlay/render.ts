import type {
  WeatherGridDefinition,
  WeatherOverlayMetric,
  WeatherOverlayMode,
  WeatherOverlaySample,
} from './types';
import { getWeatherOverlayColorStops } from '../config/paletteMetrics';

interface PaletteBandLike {
  color: string;
  visible?: boolean;
  minValue?: number;
  maxValue?: number;
}

type Color = readonly [number, number, number];
type ColorStop = readonly [number, Color];
type ColorWithAlpha = readonly [number, number, number, number];

interface NumericRange {
  min: number;
  max: number;
}

const COLOR_LOOKUP_SIZE = 2048;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexToRgb(hex: string): Color {
  const safe = hex.replace('#', '').trim();
  const expanded = safe.length === 3
    ? safe.split('').map((char) => `${char}${char}`).join('')
    : safe.padEnd(6, '0').slice(0, 6);
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = clamp(Math.round((sorted.length - 1) * ratio), 0, sorted.length - 1);
  return sorted[index];
}

function valuesForMetric(metric: WeatherOverlayMetric, samples: WeatherOverlaySample[]): number[] {
  return samples
    .map((sample) => sample[metric])
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
}

function rangeForMetric(metric: WeatherOverlayMetric, samples: WeatherOverlaySample[]): NumericRange {
  const values = valuesForMetric(metric, samples);
  if (values.length === 0) return { min: 0, max: 1 };

  if (metric === 'cloudCover' || metric === 'humidity') {
    return { min: 0, max: 100 };
  }

  if (metric === 'rain') {
    return { min: 0, max: Math.max(0.4, percentile(values, 0.9)) };
  }

  const min = values[0];
  const max = values[values.length - 1];
  if (max - min < 6) {
    const mid = (min + max) * 0.5;
    return { min: mid - 3, max: mid + 3 };
  }
  return { min, max };
}

function paletteStops(
  metric: WeatherOverlayMetric,
  paletteBands: PaletteBandLike[] | undefined,
  minValue: number,
  maxValue: number,
): readonly ColorStop[] {
  if (!paletteBands?.length) return getWeatherOverlayColorStops(metric);

  const span = Math.max(1e-6, maxValue - minValue);
  const stops = paletteBands.map((band, index) => {
    const fallbackRatio = paletteBands.length === 1 ? 1 : index / (paletteBands.length - 1);
    const startValue = Number.isFinite(band.minValue) ? band.minValue ?? minValue : minValue + span * fallbackRatio;
    const ratio = clamp((startValue - minValue) / span, 0, 1);
    return [ratio, hexToRgb(band.color)] as const;
  });

  const lastBand = paletteBands[paletteBands.length - 1];
  const lastRatio = clamp(
    ((Number.isFinite(lastBand?.maxValue) ? lastBand.maxValue ?? maxValue : maxValue) - minValue) / span,
    0,
    1,
  );
  const lastColor = hexToRgb(lastBand?.color ?? paletteBands[paletteBands.length - 1]?.color ?? '#FFFFFF');
  if (lastRatio > (stops[stops.length - 1]?.[0] ?? 0)) stops.push([lastRatio, lastColor] as const);
  return stops;
}

function paletteRange(
  metric: WeatherOverlayMetric,
  samples: WeatherOverlaySample[],
  paletteBands?: PaletteBandLike[],
): NumericRange {
  const sampleRange = rangeForMetric(metric, samples);
  if (!paletteBands?.length) return sampleRange;
  const rawMinValue = paletteBands[0]?.minValue;
  const rawMaxValue = paletteBands[paletteBands.length - 1]?.maxValue;
  if (!Number.isFinite(rawMinValue) || !Number.isFinite(rawMaxValue)) return sampleRange;
  const minValue = rawMinValue as number;
  const maxValue = rawMaxValue as number;
  if (maxValue === minValue) return sampleRange;
  return { min: minValue, max: maxValue };
}

function steppedBandColor(paletteBands: PaletteBandLike[], value: number): Color {
  for (const band of paletteBands) {
    if (Number.isFinite(band.maxValue) && value < (band.maxValue as number)) return hexToRgb(band.color);
  }
  return hexToRgb(paletteBands[paletteBands.length - 1]?.color ?? '#FFFFFF');
}

function bandAlpha(paletteBands: PaletteBandLike[] | undefined, value: number): number {
  if (!paletteBands?.length) return 255;
  for (const band of paletteBands) {
    if (Number.isFinite(band.maxValue) && value < (band.maxValue as number)) {
      return band.visible === false ? 0 : 255;
    }
  }
  return paletteBands[paletteBands.length - 1]?.visible === false ? 0 : 255;
}

function interpolatePaletteColor(stops: readonly ColorStop[], ratio: number): Color {
  const clamped = clamp(ratio, 0, 1);
  for (let index = 1; index < stops.length; index += 1) {
    const [nextT, nextColor] = stops[index];
    const [prevT, prevColor] = stops[index - 1];
    if (clamped > nextT) continue;
    const localT = nextT === prevT ? 0 : (clamped - prevT) / (nextT - prevT);
    return [
      Math.round(lerp(prevColor[0], nextColor[0], localT)),
      Math.round(lerp(prevColor[1], nextColor[1], localT)),
      Math.round(lerp(prevColor[2], nextColor[2], localT)),
    ];
  }
  return stops[stops.length - 1][1];
}

function buildColorLookup(stops: readonly ColorStop[]): Uint8ClampedArray {
  const lookup = new Uint8ClampedArray(COLOR_LOOKUP_SIZE * 3);
  for (let index = 0; index < COLOR_LOOKUP_SIZE; index += 1) {
    const ratio = COLOR_LOOKUP_SIZE <= 1 ? 0 : index / (COLOR_LOOKUP_SIZE - 1);
    const [r, g, b] = interpolatePaletteColor(stops, ratio);
    const offset = index * 3;
    lookup[offset] = r;
    lookup[offset + 1] = g;
    lookup[offset + 2] = b;
  }
  return lookup;
}

function colorForValue(
  raw: number,
  ratio: number,
  paletteBands: PaletteBandLike[] | undefined,
  colorLookup: Uint8ClampedArray,
): ColorWithAlpha {
  const alpha = bandAlpha(paletteBands, raw);
  if (alpha === 0) return [0, 0, 0, 0];
  if (paletteBands?.length) {
    const [r, g, b] = steppedBandColor(paletteBands, raw);
    return [r, g, b, alpha];
  }
  const lookupOffset = Math.round(ratio * (COLOR_LOOKUP_SIZE - 1)) * 3;
  return [
    colorLookup[lookupOffset],
    colorLookup[lookupOffset + 1],
    colorLookup[lookupOffset + 2],
    alpha,
  ];
}

function sampleValue(values: number[], cols: number, row: number, col: number): number {
  const clampedRow = clamp(row, 0, Math.max(0, Math.floor(values.length / cols) - 1));
  const clampedCol = clamp(col, 0, cols - 1);
  return values[clampedRow * cols + clampedCol] ?? 0;
}

function bilinear(values: number[], grid: WeatherGridDefinition, xRatio: number, yRatio: number): number {
  const fx = clamp(xRatio, 0, 1) * Math.max(0, grid.cols - 1);
  const fy = clamp(yRatio, 0, 1) * Math.max(0, grid.rows - 1);
  const c0 = Math.floor(fx);
  const c1 = Math.min(grid.cols - 1, c0 + 1);
  const r0 = Math.floor(fy);
  const r1 = Math.min(grid.rows - 1, r0 + 1);
  const tx = fx - c0;
  const ty = fy - r0;

  const top = lerp(sampleValue(values, grid.cols, r0, c0), sampleValue(values, grid.cols, r0, c1), tx);
  const bottom = lerp(sampleValue(values, grid.cols, r1, c0), sampleValue(values, grid.cols, r1, c1), tx);
  return lerp(top, bottom, ty);
}

export function renderWeatherCanvas(
  metric: WeatherOverlayMetric,
  mode: WeatherOverlayMode,
  grid: WeatherGridDefinition,
  samples: WeatherOverlaySample[],
  width: number,
  height: number,
  paletteBands?: PaletteBandLike[],
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const values = samples.map((sample) => sample[metric]);
  const range = paletteRange(metric, samples, paletteBands);
  const normalise = (value: number) => clamp((value - range.min) / Math.max(1e-6, range.max - range.min), 0, 1);
  const stops = paletteStops(metric, paletteBands, range.min, range.max);
  const colorLookup = buildColorLookup(stops);

  if (mode === 'fill') {
    const cellW = width / Math.max(1, grid.cols);
    const cellH = height / Math.max(1, grid.rows);
    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.cols; col += 1) {
        const raw = sampleValue(values, grid.cols, row, col);
        const ratio = normalise(raw);
        const [r, g, b, alpha] = colorForValue(raw, ratio, paletteBands, colorLookup);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha / 255})`;
        ctx.fillRect(col * cellW, row * cellH, cellW + 1, cellH + 1);
      }
    }
    return canvas;
  }

  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const yRatio = height <= 1 ? 0 : y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const xRatio = width <= 1 ? 0 : x / (width - 1);
      const raw = bilinear(values, grid, xRatio, yRatio);
      const ratio = normalise(raw);
      const [r, g, b, alpha] = colorForValue(raw, ratio, paletteBands, colorLookup);
      const index = (y * width + x) * 4;
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}