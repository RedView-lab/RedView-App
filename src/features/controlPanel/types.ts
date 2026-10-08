/**
 * Types du panneau de contrôle — barre latérale unifiée de RedView
 * Correspond aux fonctions : map3d, lidar, labels, fitPredictor, slope, weather
 */

import type {
  ControlPanelSectionKey,
  ControlPanelSectionsOpenState,
} from './lib/persistedState';
import type { RouteDisplayQuality } from '@/features/itineraryPanel/types';
import type { DownloadProgress } from '@/features/lidar/types';
import type { MapEnvironment } from '@/features/map3d/lib/mapEnvironment';

export type BasemapId =
  | 'satellite'
  | 'streets'
  | 'osm'
  | 'topographic'
  | 'standard'
  | 'light'
  | 'dark'
  | string;

export interface Basemap {
  id: BasemapId;
  label: string;
  /** visible sur la carte */
  visible: boolean;
  /** fond de carte actuellement actif (sélectionné) */
  active?: boolean;
}

export type Basemap3dQualityId = 'slow-040' | 'terrain-1m' | 'fast-30m' | string;

interface Basemap3dQualityOption {
  value: Basemap3dQualityId;
  label: string;
}

interface Basemap3dQualityControl {
  value: Basemap3dQualityId;
  options: Basemap3dQualityOption[];
}

export type MapEnvironmentId = MapEnvironment;

interface MapEnvironmentControl {
  value: MapEnvironmentId;
  options: Array<{ value: MapEnvironmentId; label: string }>;
}

export interface LidarTile {
  id: string;
  /** p. ex. « Tuile 1 (LIDAR) (2102mo) (2026 IGN) » */
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

interface RoutesSectionState {
  enabled: boolean;
  items: RouteItem[];
  /** Épaisseur globale des lignes de trace, en px. */
  traceWidthPx: number;
  /** Finesse des traces dessinées (vue) ; `auto` suit la 2D / 3D et le relief. */
  quality: RouteDisplayQuality;
}

export type SlopeResolution = '0.40m (LIDAR SURFACE)' | '1m (LIDAR TERRAIN)' | string;
export type SlopeColorization = 'gradient' | 'stepped' | string;
export type SlopeScale = 'percent' | 'degree' | string;
export type SlopeScaleSetting = '2 couleurs' | '3 couleurs' | '4 couleurs' | '6 couleurs' | '8 couleurs' | '10 couleurs' | string;

export type AltitudeColorization = 'gradient' | 'stepped' | string;
export type AltitudeScaleSetting = '2 couleurs' | '3 couleurs' | '4 couleurs' | '6 couleurs' | string;
export type ContourIntervalSetting = '10m' | '20m' | '50m' | '100m' | '200m' | string;
export type SunlightScaleSetting = '2 couleurs' | '3 couleurs' | '4 couleurs' | '6 couleurs' | '8 couleurs' | '10 couleurs' | '12 couleurs' | string;

export interface SlopeBand {
  id: string;
  /** e.g. "0% - 12%" */
  percentRange: string;
  /** e.g. "0° - 7° (Plat)" */
  degreeRange: string;
  /** Optional richer label, e.g. "0% - 12% (Modéré)" */
  label?: string;
  /** hexadécimal avec ou sans # */
  color: string;
  visible: boolean;
  /** Borne inférieure numérique en degrés (incluse). Toujours 0 pour la première bande. */
  minDeg: number;
  /** Borne supérieure numérique en degrés (exclue). Toujours 90 pour la dernière bande. */
  maxDeg: number;
}

export interface AltitudeBand {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  minMeters: number;
  maxMeters: number;
}

interface AltitudeState {
  colorization: AltitudeColorization;
  scaleSetting: AltitudeScaleSetting;
  opacity: number;
  bands: AltitudeBand[];
}

export interface SlopesState {
  resolution?: SlopeResolution;
  resolutionLabel?: string;
  colorization: SlopeColorization;
  scale: SlopeScale;
  scaleSetting: SlopeScaleSetting;
  /** 0..100 */
  opacity: number;
  bands: SlopeBand[];
  terrainQuality?: 'hd' | 'fast-30m';
  terrainProfile?: 'default' | 'terrain';
}

export type WeatherLayerKey =
  | 'temperature'
  | 'feelsLike'
  | 'rain'
  | 'wind'
  | 'cloudCover'
  | 'humidity'
  | 'sunshine';
export type WeatherRenderMode = 'gradient' | 'fill' | 'slope' | 'arrows' | 'text' | '-' | string;

export type WeatherPaletteScaleSetting = '2 couleurs' | '3 couleurs' | '4 couleurs' | '6 couleurs';

export interface WeatherPaletteBand {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  minValue: number;
  maxValue: number;
}

export interface WeatherPaletteConfig {
  opacity: number;
  scaleSetting: WeatherPaletteScaleSetting;
  bands: WeatherPaletteBand[];
}

export interface SunlightBand {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  minMinutes: number;
  maxMinutes: number;
}

export interface WeatherLayer {
  key: WeatherLayerKey;
  enabled: boolean;
  mode: WeatherRenderMode;
}

export interface WeatherState {
  enabled: boolean;
  customDateEnabled: boolean;
  /** ISO aaaa-mm-jj */
  date: string;
  /** HH:mm */
  time: string;
  /** 0 | 1 | 2 — décalage du jour de prévision par rapport à aujourd'hui */
  forecastDay: number;
  layers: WeatherLayer[];
  palettes: Partial<Record<WeatherLayerKey, WeatherPaletteConfig>>;
}

export interface ToggleOnlySection {
  enabled: boolean;
}

interface ContourLinesState extends ToggleOnlySection {
  interval: ContourIntervalSetting;
  /** 0..100 */
  opacity: number;
  /** Vrai quand le fond de carte actif prend en charge la surcouche des courbes de niveau. */
  available: boolean;
}

export interface WindPanelState extends ToggleOnlySection {
  date: string;
  time: string;
  forecastDay: number;
  particlesEnabled: boolean;
  terrainOverlayEnabled: boolean;
  loading: boolean;
  progress: number;
  detail: string | null;
  error: string | null;
  pointCount: number;
  lastUpdate: number | null;
  source: string | null;
}

export interface SunlightState {
  enabled: boolean;
  customDateEnabled: boolean;
  date: string;
  time: string;
  /** Vrai pendant que l'utilisateur fait glisser le curseur de temps. */
  timeScrubbing: boolean;
  sunriseTime: string;
  sunsetTime: string;
  /** Ombres du relief par lancer de rayons sur le DEM */
  shadowEnabled: boolean;
  /** Surcouche raster d'ensoleillement cumulé */
  sunlightMapEnabled: boolean;
  /** Opacité de la surcouche d'ombres, 0..100 */
  shadowOpacity: number;
  /** Opacité de la surcouche de carte d'ensoleillement, 0..100 */
  sunlightMapOpacity: number;
  scaleSetting: SunlightScaleSetting;
  bands: SunlightBand[];
  trajectoryEnabled: boolean;
}

export interface ControlPanelState {
  basemaps: Basemap[];
  basemap3dQuality: Basemap3dQualityControl;
  mapEnvironment: MapEnvironmentControl;
  lidarTiles: LidarTile[];
  labels: { enabled: boolean; state: LabelsState };
  contourLines: ContourLinesState;
  routes: RoutesSectionState;
  slopes: { enabled: boolean } & SlopesState;
  altitude: { enabled: boolean } & AltitudeState;
  weather: WeatherState;
  wind: WindPanelState;
  snow: ToggleOnlySection;
  sunlight: SunlightState;
}

export interface ControlPanelHandlers {
  onBasemapToggle?: (id: BasemapId) => void;
  onBasemap3dQualityChange?: (value: Basemap3dQualityId) => void;
  onMapEnvironmentChange?: (value: MapEnvironmentId) => void;
  onBasemapAdd?: () => void;

  onLidarTileToggle?: (id: string) => void;
  onLidarTileDelete?: (id: string) => void;
  onLidarTileRename?: (id: string, name: string) => void;
  onLidarTileDownload?: () => void;
  /** Annule le mode sélection de tuile LiDAR. */
  onLidarSelectionCancel?: () => void;
  /** Annule le téléchargement LiDAR en cours (clic sur le bouton de progression). */
  onLidarDownloadCancel?: () => void;
  /** Déclenché quand l'utilisateur clique sur l'œil d'une tuile — ouvre le visualiseur 3D. */
  onLidarTileOpen?: (id: string) => void;

  onLabelsEnabledChange?: (enabled: boolean) => void;
  onLabelToggle?: (key: LabelKey, checked: boolean) => void;
  onContourLinesEnabledChange?: (enabled: boolean) => void;
  onContourLinesIntervalChange?: (value: ContourIntervalSetting) => void;
  onContourLinesOpacityChange?: (value: number) => void;

  onRoutesEnabledChange?: (enabled: boolean) => void;
  onRouteColorChange?: (id: string, color: string) => void;
  onRouteModeChange?: (id: string, mode: RouteRenderMode) => void;
  onRouteOpacityChange?: (id: string, opacity: number) => void;
  onRouteVisibilityToggle?: (id: string) => void;
  onRouteTraceWidthChange?: (value: number) => void;
  onRouteQualityChange?: (quality: RouteDisplayQuality) => void;

  onSlopesEnabledChange?: (enabled: boolean) => void;
  onSlopeResolutionChange?: (value: SlopeResolution) => void;
  onSlopeColorizationChange?: (value: SlopeColorization) => void;
  onSlopeScaleChange?: (value: SlopeScale) => void;
  onSlopeScaleSettingChange?: (value: SlopeScaleSetting) => void;
  onSlopeOpacityChange?: (value: number) => void;
  onSlopeBandColorChange?: (id: string, color: string) => void;
  onSlopeBandVisibilityToggle?: (id: string) => void;
  /** Appelé quand l'utilisateur modifie en ligne un seuil en degrés d'une bande.
   *  bandIndex commence à 0. field vaut 'min' ou 'max'. valueDeg est le nouvel angle en degrés. */
  onSlopeBandBreakpointChange?: (bandIndex: number, field: 'min' | 'max', valueDeg: number) => void;

  onAltitudeEnabledChange?: (enabled: boolean) => void;
  onAltitudeColorizationChange?: (value: AltitudeColorization) => void;
  onAltitudeScaleSettingChange?: (value: AltitudeScaleSetting) => void;
  onAltitudeOpacityChange?: (value: number) => void;
  onAltitudeBandColorChange?: (id: string, color: string) => void;
  onAltitudeBandVisibilityToggle?: (id: string) => void;
  onAltitudeBandBreakpointChange?: (bandIndex: number, field: 'min' | 'max', valueMeters: number) => void;

  onWeatherEnabledChange?: (enabled: boolean) => void;
  onWeatherDateChange?: (dateState: Partial<Pick<WeatherState, 'customDateEnabled' | 'date' | 'time' | 'forecastDay'>>) => void;
  onWeatherLayerToggle?: (key: WeatherLayerKey, enabled: boolean) => void;
  onWeatherLayerModeChange?: (key: WeatherLayerKey, mode: WeatherRenderMode) => void;
  onWeatherPaletteOpacityChange?: (key: WeatherLayerKey, opacity: number) => void;
  onWeatherPaletteScaleSettingChange?: (key: WeatherLayerKey, value: WeatherPaletteScaleSetting) => void;
  onWeatherPaletteBandColorChange?: (key: WeatherLayerKey, bandId: string, color: string) => void;
  onWeatherPaletteBandVisibilityToggle?: (key: WeatherLayerKey, bandId: string) => void;
  onWeatherPaletteBandBreakpointChange?: (
    key: WeatherLayerKey,
    bandIndex: number,
    field: 'min' | 'max',
    value: number,
  ) => void;

  onWindEnabledChange?: (enabled: boolean) => void;
  onWindDateChange?: (changes: Partial<Pick<WindPanelState, 'date' | 'time' | 'forecastDay' | 'particlesEnabled' | 'terrainOverlayEnabled'>>) => void;
  onSnowEnabledChange?: (enabled: boolean) => void;
  onSunlightEnabledChange?: (enabled: boolean) => void;
  onSunlightStateChange?: (changes: Partial<SunlightState>) => void;
}

export interface ControlPanelProps extends ControlPanelHandlers {
  state: ControlPanelState;
  lidarDownloadProgress?: DownloadProgress | null;
  lidarDownloadError?: string | null;
  lidarDownloadModeActive?: boolean;
  className?: string;
  sectionsOpen?: ControlPanelSectionsOpenState;
  onSectionOpenChange?: (section: ControlPanelSectionKey, open: boolean) => void;
  sunlightMapExpanded?: boolean;
  onSunlightMapExpandedChange?: (open: boolean) => void;
  /** Faux tant qu'aucune zone d'analyse n'est dessinée — les sections conditionnées à une zone affichent une aide. */
  analysisZoneActive?: boolean;
  /** Largeur optionnelle en px de la coque du panneau ('100%' = remplit son hôte, utilisé pendant le redimensionnement). */
  width?: number | '100%';
  /** Gestionnaire mouse-down sur la poignée de redimensionnement (bord gauche). */
  onResizeStart?: (ev: import('react').MouseEvent<HTMLDivElement>) => void;
  /** Active un état visuel pendant le glisser. */
  isResizing?: boolean;
}
