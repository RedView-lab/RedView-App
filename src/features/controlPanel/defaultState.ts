import type { ControlPanelState } from './types';

/**
 * Default state that mirrors the Figma mock data (see node 1407:17211).
 * Useful as a starting point before wiring to real backend state.
 */
export const DEFAULT_CONTROL_PANEL_STATE: ControlPanelState = {
  basemaps: [
    { id: 'satellite', label: 'Satellite', visible: true, active: true },
    { id: 'osm', label: 'Openstreetmap', visible: false },
    { id: 'topographic', label: 'Topographique', visible: false },
  ],
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
  weather: {
    enabled: true,
    tab: 'forecast',
    customDateEnabled: true,
    date: '2026-04-22',
    time: '09:30',
    forecastDay: 0,
    trendMode: 'date',
    layers: [
      { key: 'temperature', enabled: true, mode: 'text' },
      { key: 'feelsLike', enabled: false, mode: '-' },
      { key: 'rain', enabled: true, mode: 'gradient' },
      { key: 'wind', enabled: true, mode: 'arrows' },
      { key: 'cloudCover', enabled: false, mode: '-' },
      { key: 'humidity', enabled: false, mode: '-' },
      { key: 'sunshine', enabled: false, mode: '-' },
    ],
  },
  wind: { enabled: true },
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
