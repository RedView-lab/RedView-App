import type { Map as MapboxMap } from 'mapbox-gl';
import { logger } from '@/shared/lib/logger';
import { clampForecastSelection } from '../../lib/forecastTime.ts';
import type {
  WeatherOverlayMetric,
  WeatherOverlayMode,
  WeatherOverlayState,
} from '../types';
import type { RefreshReason } from './constants';
import { SUPPORTED_KEYS } from './constants';

export type ImageCoords = [[number, number], [number, number], [number, number], [number, number]];

export interface RenderedLayerEntry {
  url: string;
  coords: ImageCoords;
  signature: string;
}

export interface StyleHealth {
  hasStyle: boolean;
  isStyleLoaded: boolean;
  sourceCount: number;
  layerCount: number;
  importCount: number;
  hasImportContent: boolean;
}

/** Heure de prévision affichée (bornée à l'horizon du VPS) : change quand l'utilisateur fait défiler le temps. */
export function weatherSelectionKey(state: WeatherOverlayState): string {
  const forecast = clampForecastSelection({
    date: state.date,
    time: state.time,
    forecastDay: state.forecastDay,
  });
  return `forecast:${forecast.date}T${forecast.time}`;
}

export function activeRenderableLayers(
  state: WeatherOverlayState,
): { key: WeatherOverlayMetric; mode: WeatherOverlayMode }[] {
  return state.layers
    .filter((layer): layer is { key: WeatherOverlayMetric; enabled: boolean; mode: WeatherOverlayMode } =>
      SUPPORTED_KEYS.includes(layer.key as WeatherOverlayMetric)
      && layer.enabled
      && (layer.mode === 'gradient' || layer.mode === 'fill'),
    )
    .map((layer) => ({ key: layer.key, mode: layer.mode }));
}

export function imageCoords(bounds: [number, number, number, number]): ImageCoords {
  return [
    [bounds[0], bounds[3]],
    [bounds[2], bounds[3]],
    [bounds[2], bounds[1]],
    [bounds[0], bounds[1]],
  ];
}

export function coordsEqual(left: ImageCoords, right: ImageCoords): boolean {
  return left.every((point, index) => point[0] === right[index]?.[0] && point[1] === right[index]?.[1]);
}

function hashStr(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function paletteSignature(state: WeatherOverlayState, key: WeatherOverlayMetric): string {
  const palette = state.palettes?.[key];
  if (!palette) return '0';
  let h = hashStr(`${palette.scaleSetting ?? ''}`);
  const bands = palette.bands;
  if (bands) {
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      h = hashStr(`|${band.color}|${band.visible !== false ? 1 : 0}|${band.minValue}|${band.maxValue}`, h);
    }
  }
  return h.toString(36);
}

export function paletteOpacity(state: WeatherOverlayState, key: WeatherOverlayMetric): number {
  const opacity = state.palettes?.[key]?.opacity ?? 100;
  return Math.max(0, Math.min(1, opacity / 100));
}

export function styleSyncProgress(reason: RefreshReason): number {
  if (reason === 'reload') return 8;
  if (reason === 'force') return 74;
  return 12;
}

export function readStyleHealth(map: MapboxMap): StyleHealth {
  try {
    const style = map.getStyle();
    const imports = (style as { imports?: Array<{ data?: unknown }> } | null | undefined)?.imports;
    const hasImportContent = Array.isArray(imports)
      && imports.some((entry) => entry && entry.data != null);
    return {
      hasStyle: Boolean(style),
      isStyleLoaded: map.isStyleLoaded(),
      sourceCount: Object.keys(style?.sources ?? {}).length,
      layerCount: Array.isArray(style?.layers) ? style.layers.length : 0,
      importCount: Array.isArray(imports) ? imports.length : 0,
      hasImportContent,
    };
  } catch {
    return {
      hasStyle: false,
      isStyleLoaded: false,
      sourceCount: 0,
      layerCount: 0,
      importCount: 0,
      hasImportContent: false,
    };
  }
}

export function logWeatherOverlay(event: string, payload?: Record<string, unknown>): void {
  if (payload) {
    logger.weather.debug(event, payload);
    return;
  }
  logger.weather.debug(event);
}