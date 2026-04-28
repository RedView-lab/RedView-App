import type { ControlPanelState } from './types';
import { buildBasemapList, DEFAULT_BASEMAP_ID } from './basemaps';
import { buildDefaultWeatherPalettePresets } from './weather/defaultPalettes';
import { clampForecastSelection, getForecastDateForOffset } from '@/features/weather/lib/forecastTime.ts';

const WEATHER_PALETTE_PRESETS = buildDefaultWeatherPalettePresets();

/**
 * Default state that mirrors the Figma mock data (see node 1407:17211).
 * Useful as a starting point before wiring to real backend state.
 */
export const DEFAULT_CONTROL_PANEL_STATE: ControlPanelState = {
  basemaps: buildBasemapList(DEFAULT_BASEMAP_ID),
  lidarTiles: [
    { id: 'tile-1', label: 'Tuile 1 (LIDAR) (2102mo) (2026 IGN)', sizeMb: 2102, year: 2026, source: 'LIDAR', visible: true },
    { id: 'tile-2', label: 'Tuile 1 (LIDAR) (2102mo) (2026 IGN)', sizeMb: 2102, year: 2026, source: 'LIDAR', visible: true },
    { id: 'tile-3', label: 'Tuile 1 (LIDAR) (2102mo) (2026 IGN)', sizeMb: 2102, year: 2026, source: 'LIDAR', visible: true },
    { id: 'tile-4', label: 'Tuile 1 (LIDAR) (2102mo) (2026 IGN)', sizeMb: 2102, year: 2026, source: 'LIDAR', visible: true },
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
  routes: {
    enabled: true,
    items: [
      { id: 'route-1', label: 'Itinéraire 1', color: '#c50000', mode: 'default', opacity: 100, visible: true },
      { id: 'route-2', label: 'Variante 2', color: '#ffa630', mode: 'slope', opacity: 100, visible: true },
      { id: 'route-3', label: 'GPX Jerem', color: '#ffcd57', mode: 'speedEst', opacity: 100, visible: true },
    ],
  },
  slopes: {
    enabled: true,
    resolution: '1m (LIDAR)',
    colorization: 'gradient',
    scale: 'percent',
    scaleSetting: '4 couleurs',
    opacity: 20,
    bands: [
      { id: 'band-1', percentRange: '0% - 12%',    degreeRange: '0° - 7° (Plat)',           label: '0% - 12% (Modéré)',         color: '#2DBF8C', visible: true, minDeg: 0,  maxDeg: 7  },
      { id: 'band-2', percentRange: '12% - 27%',   degreeRange: '7° - 15° (Pente modérée)', label: '12% - 27% (Pentu)',          color: '#FFD800', visible: true, minDeg: 7,  maxDeg: 15 },
      { id: 'band-3', percentRange: '27% - 47%',   degreeRange: '15° - 25° (Pente forte)',  label: '27% - 47% (Très pentu)',     color: '#FF7200', visible: true, minDeg: 15, maxDeg: 25 },
      { id: 'band-4', percentRange: '47% - 70%',   degreeRange: '25° - 35° (Très raide)',   label: '47% - 70% (Vertical)',       color: '#E50C0C', visible: true, minDeg: 25, maxDeg: 35 },
      { id: 'band-5', percentRange: '70% - 100%',  degreeRange: '35° - 45° (Extrême)',      label: '70% - 100% (Extrême)',       color: '#E5261F', visible: true, minDeg: 35, maxDeg: 45 },
      { id: 'band-6', percentRange: '>100%',        degreeRange: '45° - 90° (Falaise)',      label: '>100% (Falaise)',            color: '#8B0000', visible: true, minDeg: 45, maxDeg: 90 },
    ],
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
    time: '09:30',
    timeScrubbing: false,
    sunriseTime: '06:45',
    sunsetTime: '19:33',
    shadowEnabled: true,
    shadowOpacity: 50,
  },
};
