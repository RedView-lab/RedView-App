import type { Map as MapboxMap } from 'mapbox-gl';
import type { OverlayReloadRegistrar, OverlayStatusReporter } from '@/features/map3d';

import type { ControlPanelPersistedState } from '../lib/persistedState';
import type {
  ControlPanelState,
  LabelKey,
  SunlightState,
  WeatherLayerKey,
  WeatherPaletteScaleSetting,
  WeatherRenderMode,
  WeatherState,
  WeatherTab,
} from '../types';

import { useOverlayLabelsState } from './overlays/useOverlayLabelsState';
import { useOverlayWeatherState } from './overlays/useOverlayWeatherState';
import { useOverlayWindSnowState } from './overlays/useOverlayWindSnowState';
import { useOverlaySunlightState } from './overlays/useOverlaySunlightState';

export interface UseControlPanelOverlayStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
  /**
   * Analysis zone restricting the sunlight overlays (zone-gated widgets):
   * null while no polygon is drawn → overlays stay off / get disabled.
   */
  analysisZone: {
    key: string;
    bounds: [number, number, number, number];
    ring: number[];
  } | null;
  onWeatherOverlayStatusChange?: OverlayStatusReporter;
  onWeatherOverlayReloadChange?: OverlayReloadRegistrar;
  onWindOverlayStatusChange?: OverlayStatusReporter;
  onWindOverlayReloadChange?: OverlayReloadRegistrar;
  onShadowOverlayStatusChange?: OverlayStatusReporter;
  onShadowOverlayReloadChange?: OverlayReloadRegistrar;
  onSunlightMapOverlayStatusChange?: OverlayStatusReporter;
  onSunlightMapOverlayReloadChange?: OverlayReloadRegistrar;
}

export interface OverlayHandlers {
  onLabelsEnabledChange: (enabled: boolean) => void;
  onLabelToggle: (key: LabelKey, checked: boolean) => void;
  onWeatherEnabledChange: (enabled: boolean) => void;
  onWeatherTabChange: (tab: WeatherTab) => void;
  onWeatherDateChange: (changes: Partial<Pick<WeatherState, 'customDateEnabled' | 'date' | 'time' | 'forecastDay' | 'trendMode'>>) => void;
  onWeatherLayerToggle: (key: WeatherLayerKey, enabled: boolean) => void;
  onWeatherLayerModeChange: (key: WeatherLayerKey, mode: WeatherRenderMode) => void;
  onWeatherPaletteOpacityChange: (key: WeatherLayerKey, opacity: number) => void;
  onWeatherPaletteScaleSettingChange: (key: WeatherLayerKey, value: WeatherPaletteScaleSetting) => void;
  onWeatherPaletteBandColorChange: (key: WeatherLayerKey, bandId: string, color: string) => void;
  onWeatherPaletteBandVisibilityToggle: (key: WeatherLayerKey, bandId: string) => void;
  onWeatherPaletteBandBreakpointChange: (key: WeatherLayerKey, bandIndex: number, field: 'min' | 'max', value: number) => void;
  onWeatherAddAlert: () => void;
  onWindEnabledChange: (enabled: boolean) => void;
  onWindDateChange: (changes: Partial<Pick<ControlPanelState['wind'], 'date' | 'time' | 'forecastDay' | 'particlesEnabled' | 'terrainOverlayEnabled'>>) => void;
  onSnowEnabledChange: (enabled: boolean) => void;
  onSunlightEnabledChange: (enabled: boolean) => void;
  onSunlightStateChange: (changes: Partial<SunlightState>) => void;
}

export interface OverlayStateResult {
  slices: Pick<ControlPanelState, 'labels' | 'weather' | 'wind' | 'snow' | 'sunlight'>;
  handlers: OverlayHandlers;
}

/**
 * Hook orchestrateur pour la gestion globale des couches d'overlay (Étiquettes, Météo, Vent, Neige, Ensoleillement).
 */
export function useControlPanelOverlayState({
  map,
  isMapLoaded,
  initialControlPanel,
  updateProjectControlPanel,
  analysisZone,
  onWeatherOverlayStatusChange,
  onWeatherOverlayReloadChange,
  onWindOverlayStatusChange,
  onWindOverlayReloadChange,
  onShadowOverlayStatusChange,
  onShadowOverlayReloadChange,
  onSunlightMapOverlayStatusChange,
  onSunlightMapOverlayReloadChange,
}: UseControlPanelOverlayStateArgs): OverlayStateResult {
  const { labelsSlice, handlers: labelHandlers } = useOverlayLabelsState({
    map,
    isMapLoaded,
    initialControlPanel,
    updateProjectControlPanel,
  });

  const { weatherSlice, handlers: weatherHandlers } = useOverlayWeatherState({
    map,
    isMapLoaded,
    initialControlPanel,
    updateProjectControlPanel,
    onWeatherOverlayStatusChange,
    onWeatherOverlayReloadChange,
  });

  const { windSlice, snowSlice, handlers: windSnowHandlers } = useOverlayWindSnowState({
    map,
    isMapLoaded,
    initialControlPanel,
    updateProjectControlPanel,
    onWindOverlayStatusChange,
    onWindOverlayReloadChange,
  });

  const { sunlightSlice, handlers: sunlightHandlers } = useOverlaySunlightState({
    map,
    isMapLoaded,
    initialControlPanel,
    updateProjectControlPanel,
    analysisZone,
    onShadowOverlayStatusChange,
    onShadowOverlayReloadChange,
    onSunlightMapOverlayStatusChange,
    onSunlightMapOverlayReloadChange,
  });

  return {
    slices: {
      labels: labelsSlice,
      weather: weatherSlice,
      wind: windSlice,
      snow: snowSlice,
      sunlight: sunlightSlice,
    },
    handlers: {
      ...labelHandlers,
      ...weatherHandlers,
      ...windSnowHandlers,
      ...sunlightHandlers,
    },
  };
}
