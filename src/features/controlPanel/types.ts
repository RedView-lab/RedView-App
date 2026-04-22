/**
 * Control Panel types — unified sidebar for RedView
 * Maps to backend features: map3d, lidar, labels, fitPredictor, slope, weather
 */

import type {
  ControlPanelSectionKey,
  ControlPanelSectionsOpenState,
} from './persistedState';

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

export type SlopeResolution = '0.40m (LIDAR)' | '1m' | '5m' | '10m' | string;
export type SlopeColorization = 'gradient' | 'stepped' | string;
export type SlopeScale = 'percent' | 'degree' | string;
export type SlopeScaleSetting = '2 couleurs' | '3 couleurs' | '4 couleurs' | '6 couleurs' | string;

export interface SlopeBand {
  id: string;
  /** e.g. "0% - 12%" */
  percentRange: string;
  /** e.g. "0° - 7° (Plat)" */
  degreeRange: string;
  /** Optional richer label, e.g. "0% - 12% (Modéré)" */
  label?: string;
  /** hex with or without # */
  color: string;
  visible: boolean;
  /** Numeric lower bound in degrees (inclusive). Always 0 for first band. */
  minDeg: number;
  /** Numeric upper bound in degrees (exclusive). Always 90 for last band. */
  maxDeg: number;
}

export interface SlopesState {
  resolution: SlopeResolution;
  colorization: SlopeColorization;
  scale: SlopeScale;
  scaleSetting: SlopeScaleSetting;
  /** 0..100 */
  opacity: number;
  bands: SlopeBand[];
}

export type WeatherTab = 'forecast' | 'trends';
export type TrendMode = 'date' | 'week';
export type WeatherLayerKey =
  | 'temperature'
  | 'feelsLike'
  | 'rain'
  | 'wind'
  | 'cloudCover'
  | 'humidity'
  | 'sunshine';
export type WeatherRenderMode = 'gradient' | 'slope' | 'arrows' | 'text' | '-' | string;

export interface WeatherLayer {
  key: WeatherLayerKey;
  enabled: boolean;
  mode: WeatherRenderMode;
}

export interface WeatherState {
  enabled: boolean;
  tab: WeatherTab;
  customDateEnabled: boolean;
  /** ISO yyyy-mm-dd */
  date: string;
  /** HH:mm */
  time: string;
  /** 0 | 1 | 2 — forecast day offset from today */
  forecastDay: number;
  /** In trends tab: pick a specific date or a whole week */
  trendMode: TrendMode;
  layers: WeatherLayer[];
}

export interface ToggleOnlySection {
  enabled: boolean;
}

export interface SunlightState {
  enabled: boolean;
  customDateEnabled: boolean;
  date: string;
  time: string;
  /** True while the user is actively dragging the time slider. */
  timeScrubbing: boolean;
  sunriseTime: string;
  sunsetTime: string;
  /** DEM ray-traced terrain shadows */
  shadowEnabled: boolean;
  /** Shadow overlay opacity 0..100 */
  shadowOpacity: number;
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
  sunlight: SunlightState;
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
  onSlopeScaleChange?: (value: SlopeScale) => void;
  onSlopeScaleSettingChange?: (value: SlopeScaleSetting) => void;
  onSlopeOpacityChange?: (value: number) => void;
  onSlopeBandColorChange?: (id: string, color: string) => void;
  onSlopeBandVisibilityToggle?: (id: string) => void;
  /** Called when the user edits a band's degree breakpoint inline.
   *  bandIndex is 0-based. field is 'min' or 'max'. valueDeg is the new angle in degrees. */
  onSlopeBandBreakpointChange?: (bandIndex: number, field: 'min' | 'max', valueDeg: number) => void;

  onWeatherEnabledChange?: (enabled: boolean) => void;
  onWeatherTabChange?: (tab: WeatherTab) => void;
  onWeatherDateChange?: (dateState: Partial<Pick<WeatherState, 'customDateEnabled' | 'date' | 'time' | 'forecastDay' | 'trendMode'>>) => void;
  onWeatherLayerToggle?: (key: WeatherLayerKey, enabled: boolean) => void;
  onWeatherLayerModeChange?: (key: WeatherLayerKey, mode: WeatherRenderMode) => void;
  onWeatherAddAlert?: () => void;

  onWindEnabledChange?: (enabled: boolean) => void;
  onSnowEnabledChange?: (enabled: boolean) => void;
  onSunlightEnabledChange?: (enabled: boolean) => void;
  onSunlightStateChange?: (changes: Partial<SunlightState>) => void;
}

export interface ControlPanelProps extends ControlPanelHandlers {
  state: ControlPanelState;
  className?: string;
  sectionsOpen?: ControlPanelSectionsOpenState;
  onSectionOpenChange?: (section: ControlPanelSectionKey, open: boolean) => void;
  altitudeEnabled?: boolean;
  onAltitudeEnabledChange?: (enabled: boolean) => void;
  sunlightMapExpanded?: boolean;
  onSunlightMapExpandedChange?: (open: boolean) => void;
  /** Optional px width the panel shell should render at. */
  width?: number;
  /** Mouse-down handler on the drag-to-resize handle (left edge). */
  onResizeStart?: (ev: import('react').MouseEvent<HTMLDivElement>) => void;
  /** Toggles an active visual state while dragging. */
  isResizing?: boolean;
}
