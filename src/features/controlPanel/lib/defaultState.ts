import type { ControlPanelState } from '../types';
import { buildBasemapList, DEFAULT_BASEMAP_ID } from './basemaps';
import { buildDefaultSunlightBands, DEFAULT_SUNLIGHT_SCALE_SETTING } from './sunlightConfig';
import { buildDefaultWeatherPalettePresets } from '../weather/defaultPalettes';
import { clampForecastSelection, getForecastDateForOffset } from '@/features/weather/lib/forecastTime.ts';
import { generateDynamicCategories, formatSlopeDegreeLabel } from '@/features/slope/lib/slope-config';
import { DEFAULT_MAP_ENVIRONMENT, MAP_ENVIRONMENT_OPTIONS } from '@/features/map3d/lib/mapEnvironment';
import { DEFAULT_ROUTE_TRACE_WIDTH_PX } from '@/features/itineraryPanel/lib/route-layer/constants';

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
 * Valeurs par défaut du panneau de droite, complétées par les réglages du
 * projet (ControlPanelContainer). Les listes (tuiles LiDAR, itinéraires)
 * viennent toujours du projet : elles sont vides ici.
 */
export const DEFAULT_CONTROL_PANEL_STATE: ControlPanelState = {
  basemaps: buildBasemapList(DEFAULT_BASEMAP_ID),
  basemap3dQuality: {
    value: 'fast-30m',
    options: [
      { value: 'fast-30m', label: '30 m (Monde - Rapide)' },
      { value: 'terrain-1m', label: '1 m Sol Nu (MNT IGN - Tracé net)' },
      { value: 'slow-040', label: '0.40 m Surface (MNS - Bâtiments 3D)' },
    ],
  },
  mapEnvironment: {
    value: DEFAULT_MAP_ENVIRONMENT,
    options: MAP_ENVIRONMENT_OPTIONS.map((option) => ({ ...option })),
  },
  lidarTiles: [],
  labels: {
    enabled: true,
    state: {
      poiLabels: true,
      roads: true,
      cities: true,
      states: true,
      naturalParks: true,
      countries: true,
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
    traceWidthPx: DEFAULT_ROUTE_TRACE_WIDTH_PX,
    quality: 'auto',
    items: [],
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
    customDateEnabled: true,
    ...clampForecastSelection({
      date: getForecastDateForOffset(0),
      time: '12:00',
      forecastDay: 0,
    }),
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
    enabled: false,
    ...clampForecastSelection({
      date: getForecastDateForOffset(0),
      time: '12:00',
      forecastDay: 0,
    }),
    particlesEnabled: false,
    terrainOverlayEnabled: false,
    loading: false,
    progress: 0,
    detail: null,
    error: null,
    pointCount: 0,
    lastUpdate: null,
    source: null,
  },
  snow: { enabled: false },
  sunlight: {
    enabled: false,
    customDateEnabled: false,
    date: '2026-04-22',
    time: '19:33',
    timeScrubbing: false,
    sunriseTime: '06:45',
    sunsetTime: '19:33',
    shadowEnabled: false,
    sunlightMapEnabled: false,
    shadowOpacity: 50,
    sunlightMapOpacity: 50,
    scaleSetting: DEFAULT_SUNLIGHT_SCALE_SETTING,
    bands: buildDefaultSunlightBands(DEFAULT_SUNLIGHT_SCALE_SETTING),
    trajectoryEnabled: false,
  },
};
