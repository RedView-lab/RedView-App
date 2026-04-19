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
      { id: 'band-1', percentRange: '0% - 12%',    degreeRange: '0° - 7° (Plat)',           label: '0% - 12% (Modéré)',         color: '#2DBF8C', visible: true },
      { id: 'band-2', percentRange: '12% - 27%',   degreeRange: '7° - 15° (Pente modérée)', label: '12% - 27% (Pentu)',          color: '#FFD800', visible: true },
      { id: 'band-3', percentRange: '27% - 47%',   degreeRange: '15° - 25° (Pente forte)',  label: '27% - 47% (Très pentu)',     color: '#FF7200', visible: true },
      { id: 'band-4', percentRange: '47% - 70%',   degreeRange: '25° - 35° (Très raide)',   label: '47% - 70% (Vertical)',       color: '#E50C0C', visible: true },
      { id: 'band-5', percentRange: '70% - 100%',  degreeRange: '35° - 45° (Extrême)',      label: '70% - 100% (Extrême)',       color: '#E5261F', visible: true },
      { id: 'band-6', percentRange: '>100%',        degreeRange: '45° - 90° (Falaise)',      label: '>100% (Falaise)',            color: '#8B0000', visible: true },
    ],
  },
  weather: {
    enabled: true,
    tab: 'forecast',
    startDate: '2026-04-22',
    startTime: '09:30',
    endDate: '2026-04-22',
    endTime: '09:30',
    layers: [
      { key: 'temperature', enabled: true, mode: 'gradient', opacity: 100 },
      { key: 'weather', enabled: true, mode: 'slope', opacity: 100 },
      { key: 'wind', enabled: true, mode: 'arrows', opacity: 100 },
    ],
  },
  wind: { enabled: true },
  snow: { enabled: true },
  sunlight: { enabled: true },
};
