/**
 * RedView VPS Tile Renderer
 * Hardware-fast 1D lookup table recoloring for weather raster textures.
 * Executes in < 2ms without main thread frame drop.
 */
import type { WeatherOverlayMetric, WeatherOverlayMode } from './types';
import { getWeatherOverlayColorStops } from '../config/paletteMetrics';

interface PaletteBandLike {
  color: string;
  visible?: boolean;
  minValue?: number;
  maxValue?: number;
}

type Color = readonly [number, number, number];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexToRgb(hex: string): Color {
  const safe = hex.replace('#', '').trim();
  const expanded = safe.length === 3
    ? safe.split('').map((c) => `${c}${c}`).join('')
    : safe.padEnd(6, '0').slice(0, 6);
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function buildColorLookup(
  metric: WeatherOverlayMetric,
  mode: WeatherOverlayMode,
  paletteBands: PaletteBandLike[] | undefined,
  valMin: number,
  valMax: number,
): Uint32Array {
  const lookup = new Uint32Array(256);
  const span = Math.max(1e-5, valMax - valMin);

  // If custom palette bands exist, use them
  if (paletteBands && paletteBands.length > 0) {
    for (let b = 0; b < 256; b++) {
      const realVal = valMin + (b / 255.0) * span;

      // Find band
      let matchedIndex = paletteBands.length - 1;
      for (let i = 0; i < paletteBands.length; i++) {
        const band = paletteBands[i]!;
        const maxV = Number.isFinite(band.maxValue) ? band.maxValue! : Number.POSITIVE_INFINITY;
        if (realVal < maxV || i === paletteBands.length - 1) {
          matchedIndex = i;
          break;
        }
      }
      const matchedBand = paletteBands[matchedIndex]!;

      if (matchedBand.visible === false) {
        lookup[b] = 0; // Transparent
        continue;
      }

      if (mode === 'fill') {
        const [r, g, bl] = hexToRgb(matchedBand.color);
        // Little-endian ABGR for Canvas ImageData
        lookup[b] = (255 << 24) | (bl << 16) | (g << 8) | r;
      } else {
        // Gradient interpolation across bands
        const bandMin = Number.isFinite(matchedBand.minValue) ? matchedBand.minValue! : valMin;
        const bandMax = Number.isFinite(matchedBand.maxValue) ? matchedBand.maxValue! : valMax;
        const bandSpan = Math.max(1e-5, bandMax - bandMin);
        const t = clamp((realVal - bandMin) / bandSpan, 0, 1);

        const currentRgb = hexToRgb(matchedBand.color);
        const nextBand = paletteBands[Math.min(paletteBands.length - 1, matchedIndex + 1)]!;
        const nextRgb = hexToRgb(nextBand.color);

        const r = Math.round(lerp(currentRgb[0], nextRgb[0], t));
        const g = Math.round(lerp(currentRgb[1], nextRgb[1], t));
        const bl = Math.round(lerp(currentRgb[2], nextRgb[2], t));
        lookup[b] = (255 << 24) | (bl << 16) | (g << 8) | r;
      }
    }
    return lookup;
  }

  // Default color stops from paletteMetrics
  const defaultStops = getWeatherOverlayColorStops(metric);
  for (let b = 0; b < 256; b++) {
    const ratio = b / 255.0;
    let r = 255, g = 255, bl = 255;

    for (let i = 1; i < defaultStops.length; i++) {
      const [nextT, nextColor] = defaultStops[i]!;
      const [prevT, prevColor] = defaultStops[i - 1]!;
      if (ratio <= nextT || i === defaultStops.length - 1) {
        const localT = nextT === prevT ? 0 : clamp((ratio - prevT) / (nextT - prevT), 0, 1);
        r = Math.round(lerp(prevColor[0], nextColor[0], localT));
        g = Math.round(lerp(prevColor[1], nextColor[1], localT));
        bl = Math.round(lerp(prevColor[2], nextColor[2], localT));
        break;
      }
    }

    lookup[b] = (255 << 24) | (bl << 16) | (g << 8) | r;
  }

  return lookup;
}

const lookupCache = new Map<string, Uint32Array>();

function getOrCreateColorLookup(
  metric: WeatherOverlayMetric,
  mode: WeatherOverlayMode,
  paletteBands: PaletteBandLike[] | undefined,
  valMin: number,
  valMax: number,
): Uint32Array {
  const cacheKey = `${metric}|${mode}|${valMin}|${valMax}|${paletteBands ? JSON.stringify(paletteBands) : 'def'}`;
  const existing = lookupCache.get(cacheKey);
  if (existing) return existing;

  const lookup = buildColorLookup(metric, mode, paletteBands, valMin, valMax);
  if (lookupCache.size > 100) lookupCache.clear();
  lookupCache.set(cacheKey, lookup);
  return lookup;
}

const featherCache = new Map<string, { colFactor: Float32Array; rowFactor: Float32Array }>();

function getFeatherFactors(width: number, height: number, featherRadius: number = 32): { colFactor: Float32Array; rowFactor: Float32Array } {
  const key = `${width}x${height}@${featherRadius}`;
  const existing = featherCache.get(key);
  if (existing) return existing;

  const colFactor = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const dist = Math.min(x, width - 1 - x);
    if (dist < featherRadius) {
      const t = dist / featherRadius;
      colFactor[x] = t * t * (3 - 2 * t);
    } else {
      colFactor[x] = 1.0;
    }
  }

  const rowFactor = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const dist = Math.min(y, height - 1 - y);
    if (dist < featherRadius) {
      const t = dist / featherRadius;
      rowFactor[y] = t * t * (3 - 2 * t);
    } else {
      rowFactor[y] = 1.0;
    }
  }

  const result = { colFactor, rowFactor };
  featherCache.set(key, result);
  return result;
}

const canvasCache = new Map<string, HTMLCanvasElement>();

export function recolorTileToCanvas(
  sourceImage: HTMLImageElement | ImageBitmap,
  metric: WeatherOverlayMetric,
  mode: WeatherOverlayMode,
  paletteBands: PaletteBandLike[] | undefined,
  valMin: number = -40,
  valMax: number = 50,
): HTMLCanvasElement {
  const width = sourceImage.width;
  const height = sourceImage.height;

  let canvas = canvasCache.get(`${width}x${height}`);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvasCache.set(`${width}x${height}`, canvas);
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;

  ctx.drawImage(sourceImage, 0, 0);
  const imgData = ctx.getImageData(0, 0, width, height);
  const srcBytes = imgData.data;
  const dest32 = new Uint32Array(srcBytes.buffer);

  const lookup32 = getOrCreateColorLookup(metric, mode, paletteBands, valMin, valMax);
  const { colFactor, rowFactor } = getFeatherFactors(width, height, 32);

  for (let y = 0; y < height; y++) {
    const rf = rowFactor[y]!;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const i = rowOffset + x;
      const b = srcBytes[i * 4]!;
      const col = lookup32[b]!;
      if (col === 0) {
        dest32[i] = 0;
        continue;
      }
      const f = rf * colFactor[x]!;
      if (f < 0.999) {
        const baseA = (col >>> 24) & 0xff;
        const newA = Math.round(baseA * f);
        dest32[i] = (newA << 24) | (col & 0x00ffffff);
      } else {
        dest32[i] = col;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

export function canvasToBlobUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise<string>((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(canvas.toDataURL());
        return;
      }
      resolve(URL.createObjectURL(blob));
    }, 'image/png');
  });
}
