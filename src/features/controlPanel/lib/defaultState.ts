import type { ControlPanelState } from '../types';
import { translateAppText } from '@/shared/i18n';
import { buildBasemapList, DEFAULT_BASEMAP_ID } from './basemaps';
import { buildDefaultSunlightBands, DEFAULT_SUNLIGHT_SCALE_SETTING } from './sunlightConfig';
import { buildDefaultWeatherPalettePresets } from '../weather/defaultPalettes';
import { clampForecastSelection, getForecastDateForOffset } from '@/features/weather/lib/forecastTime.ts';
import { generateDynamicCategories, formatSlopeDegreeLabel } from '@/features/slope/lib/slope-config';

const WEATHER_PALETTE_PRESETS = buildDefaultWeatherPalettePresets();
const DEFAULT_SLOPE_BANDS = generateDynamicCategories(10).map((category) => ({
  id: category.id,
  percentRange: category.displayRange,
  degreeRange: `${formatSlopeDegreeLabel(category.minDeg)}° - ${formatSlopeDegreeLabel(category.maxDeg)}° (${category.label})`,
  label: `${category.displayRange} (${category.label})`,
  color: category.color,
  visible: true,
  minDeg: category.minDeg,
  maxDeg: category.maxDeg,
}));

/**
 * Default state that mirrors the Figma mock data (see node 1407:17211).
 * Useful as a starting point before wiring to real backend state.
 */
export const DEFAULT_CONTROL_PANEL_STATE: ControlPanelState = {
  basemaps: buildBasemapList(DEFAULT_BASEMAP_ID),
  basemap3dQuality: {
    value: 'slow-040',
    options: [
      { value: 'slow-040', label: '0.40 m (Lent)' },
      { value: 'terrain-1m', label: '1 m terrain (IGN)' },
      { value: 'fast-30m', label: '30 m (Rapide)' },
    ],
  },
  lidarTiles: [
    { id: 'tile-1', label: translateAppText('Tuile {{index}} (LIDAR) ({{size}}mo) ({{year}} IGN)', { index: 1, size: 2102, year: 2026 }), sizeMb: 2102, year: 2026, source: 'LIDAR', visible: true },
    { id: 'tile-2', label: translateAppText('Tuile {{index}} (LIDAR) ({{size}}mo) ({{year}} IGN)', { index: 2, size: 2102, year: 2026 }), sizeMb: 2102, year: 2026, source: 'LIDAR', visible: true },
    { id: 'tile-3', label: translateAppText('Tuile {{index}} (LIDAR) ({{size}}mo) ({{year}} IGN)', { index: 3, size: 2102, year: 2026 }), sizeMb: 2102, year: 2026, source: 'LIDAR', visible: true },
    { id: 'tile-4', label: translateAppText('Tuile {{index}} (LIDAR) ({{size}}mo) ({{year}} IGN)', { index: 4, size: 2102, year: 2026 }), sizeMb: 2102, year: 2026, source: 'LIDAR', visible: true },
  ],
  labels: {
    enabled: true,
    state: {
      poiLabels: true,
      roads: true,
      cities: true,
      states: true,
      naturalParks: true,
      countries: false,
      waterBody: false,
    },
  },
  contourLines: {
    enabled: false,
    interval: '200m',
    opacity: 100,
    available: true,
  },
  routes: {
    enabled: true,
    traceWidthPx: 8,
    items: [
      { id: 'route-1', label: translateAppText('Itinéraire {{index}}', { index: 1 }), color: '#c50000', mode: 'default', opacity: 100, visible: true },
      { id: 'route-2', label: translateAppText('Variante 2'), color: '#ffa630', mode: 'slope', opacity: 100, visible: true },
      { id: 'route-3', label: 'GPX Jerem', color: '#ffcd57', mode: 'speedEst', opacity: 100, visible: true },
    ],
  },
  slopes: {
    enabled: true,
    resolution: '1m (LIDAR)',
    colorization: 'gradient',
    scale: 'percent',
    scaleSetting: '10 couleurs',
    opacity: 20,
    bands: DEFAULT_SLOPE_BANDS,
  },
  altitude: {
    enabled: false,
    colorization: 'gradient',
    scaleSetting: '4 couleurs',
    opacity: 20,
    bands: [
      { id: 'alt-0', label: '0 m - 1000 m', color: '#2DBF8C', visible: true, minMeters: 0, maxMeters: 1000 },
      { id: 'alt-1000', label: '1000 m - 2000 m', color: '#FFD800', visible: true, minMeters: 1000, maxMeters: 2000 },
      { id: 'alt-2000', label: '2000 m - 3000 m', color: '#FF7200', visible: true, minMeters: 2000, maxMeters: 3000 },
      { id: 'alt-3000', label: '3000 m - 5000 m', color: '#FF0000', visible: true, minMeters: 3000, maxMeters: 5000 },
    ],
  },
  weather: {
    enabled: true,
    tab: 'forecast',
    customDateEnabled: true,
    ...clampForecastSelection({
      date: getForecastDateForOffset(0),
      time: '12:00',
      forecastDay: 0,
    }),
    trendMode: 'date',
    layers: [
      { key: 'temperature', enabled: true, mode: 'gradient' },
      { key: 'feelsLike', enabled: false, mode: 'gradient' },
      { key: 'rain', enabled: true, mode: 'gradient' },
      { key: 'wind', enabled: true, mode: 'arrows' },
      { key: 'cloudCover', enabled: false, mode: 'gradient' },
      { key: 'humidity', enabled: false, mode: 'gradient' },
      { key: 'sunshine', enabled: false, mode: '-' },
    ],
    palettes: {
      temperature: structuredClone(WEATHER_PALETTE_PRESETS.temperature),
      feelsLike: structuredClone(WEATHER_PALETTE_PRESETS.feelsLike),
      rain: structuredClone(WEATHER_PALETTE_PRESETS.rain),
      cloudCover: structuredClone(WEATHER_PALETTE_PRESETS.cloudCover),
      humidity: structuredClone(WEATHER_PALETTE_PRESETS.humidity),
    },
  },
  wind: {
    enabled: true,
    ...clampForecastSelection({
      date: getForecastDateForOffset(0),
      time: '12:00',
      forecastDay: 0,
    }),
    particlesEnabled: true,
    terrainOverlayEnabled: true,
    loading: false,
    progress: 0,
    detail: null,
    error: null,
    pointCount: 0,
    lastUpdate: null,
    source: null,
  },
  snow: { enabled: true },
  sunlight: {
    enabled: true,
    customDateEnabled: true,
    date: '2026-04-22',
    time: '19:33',
    timeScrubbing: false,
    sunriseTime: '06:45',
    sunsetTime: '19:33',
    shadowEnabled: true,
    sunlightMapEnabled: true,
    shadowOpacity: 50,
    sunlightMapOpacity: 50,
    scaleSetting: DEFAULT_SUNLIGHT_SCALE_SETTING,
    bands: buildDefaultSunlightBands(DEFAULT_SUNLIGHT_SCALE_SETTING),
    trajectoryEnabled: true,
  },
};
