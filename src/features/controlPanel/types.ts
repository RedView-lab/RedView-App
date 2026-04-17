/**
 * Control Panel types — unified sidebar for RedView
 * Maps to backend features: map3d, lidar, labels, fitPredictor, slope, weather
 */

export type BasemapId = 'satellite' | 'osm' | 'topographic' | string;

export interface Basemap {
  id: BasemapId;
  label: string;
  /** visible in the map */
  visible: boolean;
  /** currently active (selected) basemap */
  active?: boolean;
}

export interface LidarTile {
  id: string;
  /** e.g. "Tuile 1 (LIDAR) (2102mo) (2026 IGN)" */
  label: string;
  sizeMb?: number;
  year?: number;
  source?: 'LIDAR' | 'IGN' | string;
  visible: boolean;
}

export type LabelKey =
  | 'poiLabels'
  | 'roads'
  | 'cities'
  | 'states'
  | 'naturalParks'
  | 'countries'
  | 'waterBody';

export type LabelsState = Record<LabelKey, boolean>;

export type RouteRenderMode = 'default' | 'slope' | 'speedEst' | string;

export interface RouteItem {
  id: string;
  label: string;
  color: string;
  mode: RouteRenderMode;
  /** 0..100 */
  opacity: number;
  visible: boolean;
}

export type SlopeResolution = '1m (LIDAR)' | '5m' | '10m' | string;
export type SlopeColorization = 'gradient' | 'stepped' | string;

export interface SlopeBand {
  id: string;
  /** e.g. "0 - 7%" */
  percentRange: string;
  /** e.g. "0° - 23° (Plat)" */
  degreeRange: string;
  /** hex without # */
  color: string;
  visible: boolean;
}

export interface SlopesState {
  resolution: SlopeResolution;
  colorization: SlopeColorization;
  /** 0..100 */
  opacity: number;
  bands: SlopeBand[];
}

export type WeatherTab = 'forecast' | 'trends';
export type WeatherLayerKey = 'temperature' | 'weather' | 'wind';
export type WeatherRenderMode = 'gradient' | 'slope' | 'arrows' | string;

export interface WeatherLayer {
  key: WeatherLayerKey;
  enabled: boolean;
  mode: WeatherRenderMode;
  opacity: number;
}

export interface WeatherState {
  enabled: boolean;
  tab: WeatherTab;
  /** ISO yyyy-mm-dd */
  startDate: string;
  /** HH:mm */
  startTime: string;
  endDate: string;
  endTime: string;
  layers: WeatherLayer[];
}

export interface ToggleOnlySection {
  enabled: boolean;
}

export interface ControlPanelState {
  basemaps: Basemap[];
  lidarTiles: LidarTile[];
  labels: { enabled: boolean; state: LabelsState };
  routes: { enabled: boolean; items: RouteItem[] };
  slopes: { enabled: boolean } & SlopesState;
  weather: WeatherState;
  wind: ToggleOnlySection;
  snow: ToggleOnlySection;
  sunlight: ToggleOnlySection;
}

export interface ControlPanelHandlers {
  onBasemapToggle?: (id: BasemapId) => void;
  onBasemapAdd?: () => void;

  onLidarTileToggle?: (id: string) => void;
  onLidarTileDelete?: (id: string) => void;
  onLidarTileDownload?: () => void;
  /** Triggered when the user clicks the eye icon on a tile — opens 3D viewer. */
  onLidarTileOpen?: (id: string) => void;

  onLabelsEnabledChange?: (enabled: boolean) => void;
  onLabelToggle?: (key: LabelKey, checked: boolean) => void;

  onRoutesEnabledChange?: (enabled: boolean) => void;
  onRouteColorChange?: (id: string, color: string) => void;
  onRouteModeChange?: (id: string, mode: RouteRenderMode) => void;
  onRouteOpacityChange?: (id: string, opacity: number) => void;
  onRouteVisibilityToggle?: (id: string) => void;

  onSlopesEnabledChange?: (enabled: boolean) => void;
  onSlopeResolutionChange?: (value: SlopeResolution) => void;
  onSlopeColorizationChange?: (value: SlopeColorization) => void;
  onSlopeOpacityChange?: (value: number) => void;
  onSlopeBandColorChange?: (id: string, color: string) => void;
  onSlopeBandVisibilityToggle?: (id: string) => void;

  onWeatherEnabledChange?: (enabled: boolean) => void;
  onWeatherTabChange?: (tab: WeatherTab) => void;
  onWeatherRangeChange?: (range: Pick<WeatherState, 'startDate' | 'startTime' | 'endDate' | 'endTime'>) => void;
  onWeatherLayerToggle?: (key: WeatherLayerKey, enabled: boolean) => void;
  onWeatherLayerModeChange?: (key: WeatherLayerKey, mode: WeatherRenderMode) => void;
  onWeatherLayerOpacityChange?: (key: WeatherLayerKey, opacity: number) => void;
  onWeatherAddAlert?: () => void;

  onWindEnabledChange?: (enabled: boolean) => void;
  onSnowEnabledChange?: (enabled: boolean) => void;
  onSunlightEnabledChange?: (enabled: boolean) => void;
}

export interface ControlPanelProps extends ControlPanelHandlers {
  state: ControlPanelState;
  className?: string;
  /** Optional px width the panel shell should render at. */
  width?: number;
  /** Mouse-down handler on the drag-to-resize handle (left edge). */
  onResizeStart?: (ev: import('react').MouseEvent<HTMLDivElement>) => void;
  /** Toggles an active visual state while dragging. */
  isResizing?: boolean;
}
