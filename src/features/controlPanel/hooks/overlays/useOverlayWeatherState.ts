import { useCallback, useEffect, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { OverlayReloadRegistrar, OverlayStatusReporter } from '@/features/map3d';

import { useWeatherOverlay } from '@/features/weather/overlay/useWeatherOverlay';
import { clampForecastSelection, getForecastDateForOffset } from '@/features/weather/lib/forecastTime.ts';

import { DEFAULT_CONTROL_PANEL_STATE } from '../../lib/defaultState';
import { hasLegacyFeelsLikeBreakpoints, isLegacyFeelsLikePalette } from '../../weather/defaultPalettes';
import {
  buildWeatherPaletteBands,
  clampWeatherPaletteBreakpoints,
  resampleWeatherPaletteBands,
  weatherPaletteMetricSpec,
} from '../../lib/weatherPalette';
import type { ControlPanelPersistedState } from '../../lib/persistedState';
import type {
  WeatherLayerKey,
  WeatherPaletteScaleSetting,
  WeatherRenderMode,
  WeatherState,
  WeatherTab,
} from '../../types';

function normalizeWeatherLayerMode(layer: WeatherState['layers'][number]): WeatherState['layers'][number] {
  if ((layer.key === 'temperature' || layer.key === 'feelsLike') && layer.mode === 'text') {
    return { ...layer, mode: 'gradient' };
  }
  if (layer.key === 'humidity' && layer.mode === '-') {
    return { ...layer, mode: 'gradient' };
  }
  return layer;
}

export interface UseOverlayWeatherStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
  onWeatherOverlayStatusChange?: OverlayStatusReporter;
  onWeatherOverlayReloadChange?: OverlayReloadRegistrar;
}

/**
 * Hook dédié à la gestion des prévisions météo (température, vent, humidité, précipitations).
 */
export function useOverlayWeatherState({
  map,
  isMapLoaded,
  initialControlPanel,
  updateProjectControlPanel,
  onWeatherOverlayStatusChange,
  onWeatherOverlayReloadChange,
}: UseOverlayWeatherStateArgs) {
  const [weatherState, setWeatherState] = useState<WeatherState>(() => {
    const merged: WeatherState = {
      ...DEFAULT_CONTROL_PANEL_STATE.weather,
      ...(initialControlPanel.weather ?? {}),
      enabled: initialControlPanel.toggles.weatherEnabled,
    };
    merged.layers = merged.layers.map(normalizeWeatherLayerMode);

    const nextPalettes: WeatherState['palettes'] = {};
    for (const layer of merged.layers) {
      const fallback = DEFAULT_CONTROL_PANEL_STATE.weather.palettes[layer.key];
      const rawPalette = merged.palettes[layer.key] ?? fallback;
      let palette = layer.key === 'feelsLike' && isLegacyFeelsLikePalette(rawPalette)
        ? fallback
        : rawPalette;
      if (!palette || !fallback) continue;

      if (layer.key === 'feelsLike' && hasLegacyFeelsLikeBreakpoints(palette) && fallback.bands.length === palette.bands.length) {
        palette = {
          ...palette,
          bands: buildWeatherPaletteBands(
            layer.key,
            palette.bands.map((band) => band.color),
            fallback.bands.slice(0, -1).map((band) => band.maxValue),
            palette.bands.map((band) => band.visible),
          ),
        };
      }

      const sourceBands = (palette.bands?.length ? palette.bands : fallback.bands).map((band, index) => ({
        ...(fallback.bands[index] ?? fallback.bands[fallback.bands.length - 1]),
        ...band,
      }));
      nextPalettes[layer.key] = {
        opacity: Math.max(0, Math.min(100, Math.round(palette.opacity ?? fallback.opacity))),
        scaleSetting: palette.scaleSetting ?? fallback.scaleSetting,
        bands: resampleWeatherPaletteBands(layer.key, sourceBands, palette.scaleSetting ?? fallback.scaleSetting),
      };
    }

    return {
      ...merged,
      ...(merged.tab === 'forecast'
        ? clampForecastSelection({
            date: merged.date,
            time: merged.time,
            forecastDay: merged.forecastDay,
          })
        : null),
      palettes: nextPalettes,
    };
  });

  useWeatherOverlay(isMapLoaded ? map : null, isMapLoaded, weatherState, {
    statusReporter: onWeatherOverlayStatusChange,
    registerReload: onWeatherOverlayReloadChange,
  });

  const persistWeatherToProject = useCallback(
    (nextWeather: WeatherState) => {
      updateProjectControlPanel((draft) => {
        draft.toggles.weatherEnabled = nextWeather.enabled;
        draft.weather = structuredClone(nextWeather);
      });
    },
    [updateProjectControlPanel],
  );

  useEffect(() => {
    persistWeatherToProject(weatherState);
  }, [persistWeatherToProject, weatherState]);

  const handlers = {
    onWeatherEnabledChange: useCallback(
      (enabled: boolean) => setWeatherState((prev) => ({ ...prev, enabled })),
      [],
    ),
    onWeatherTabChange: useCallback(
      (tab: WeatherTab) =>
        setWeatherState((prev) => {
          if (tab !== 'forecast') return { ...prev, tab };
          return {
            ...prev,
            tab,
            ...clampForecastSelection({
              date: prev.date,
              time: prev.time,
              forecastDay: prev.forecastDay,
            }),
          };
        }),
      [],
    ),
    onWeatherDateChange: useCallback(
      (changes: Partial<Pick<WeatherState, 'customDateEnabled' | 'date' | 'time' | 'forecastDay' | 'trendMode'>>) =>
        setWeatherState((prev) => {
          const next = { ...prev, ...changes };
          if (next.tab !== 'forecast') return next;
          const resolvedDate = changes.forecastDay != null
            ? getForecastDateForOffset(changes.forecastDay)
            : next.date;
          return {
            ...next,
            ...clampForecastSelection({
              date: resolvedDate,
              time: next.time,
              forecastDay: next.forecastDay,
            }),
          };
        }),
      [],
    ),
    onWeatherLayerToggle: useCallback(
      (key: WeatherLayerKey, enabled: boolean) =>
        setWeatherState((prev) => ({
          ...prev,
          layers: prev.layers.map((layer) => (layer.key === key ? { ...layer, enabled } : layer)),
        })),
      [],
    ),
    onWeatherLayerModeChange: useCallback(
      (key: WeatherLayerKey, mode: WeatherRenderMode) =>
        setWeatherState((prev) => ({
          ...prev,
          layers: prev.layers.map((layer) => (layer.key === key ? { ...layer, mode } : layer)),
        })),
      [],
    ),
    onWeatherPaletteOpacityChange: useCallback(
      (key: WeatherLayerKey, opacity: number) =>
        setWeatherState((prev) => ({
          ...prev,
          palettes: {
            ...prev.palettes,
            [key]: prev.palettes[key] ? { ...prev.palettes[key], opacity } : prev.palettes[key],
          },
        })),
      [],
    ),
    onWeatherPaletteScaleSettingChange: useCallback(
      (key: WeatherLayerKey, value: WeatherPaletteScaleSetting) =>
        setWeatherState((prev) => {
          const palette = prev.palettes[key];
          if (!palette) return prev;
          return {
            ...prev,
            palettes: {
              ...prev.palettes,
              [key]: {
                ...palette,
                scaleSetting: value,
                bands: resampleWeatherPaletteBands(key, palette.bands, value),
              },
            },
          };
        }),
      [],
    ),
    onWeatherPaletteBandColorChange: useCallback(
      (key: WeatherLayerKey, bandId: string, color: string) =>
        setWeatherState((prev) => {
          const palette = prev.palettes[key];
          if (!palette) return prev;
          return {
            ...prev,
            palettes: {
              ...prev.palettes,
              [key]: {
                ...palette,
                bands: palette.bands.map((band) => (band.id === bandId ? { ...band, color } : band)),
              },
            },
          };
        }),
      [],
    ),
    onWeatherPaletteBandVisibilityToggle: useCallback(
      (key: WeatherLayerKey, bandId: string) =>
        setWeatherState((prev) => {
          const palette = prev.palettes[key];
          if (!palette) return prev;
          return {
            ...prev,
            palettes: {
              ...prev.palettes,
              [key]: {
                ...palette,
                bands: palette.bands.map((band) => (
                  band.id === bandId ? { ...band, visible: !band.visible } : band
                )),
              },
            },
          };
        }),
      [],
    ),
    onWeatherPaletteBandBreakpointChange: useCallback(
      (key: WeatherLayerKey, bandIndex: number, field: 'min' | 'max', value: number) =>
        setWeatherState((prev) => {
          const palette = prev.palettes[key];
          const spec = weatherPaletteMetricSpec(key);
          if (!palette || !spec) return prev;

          const breakpoints = palette.bands.slice(0, -1).map((band) => band.maxValue);
          let breakpointIndex: number;
          if (field === 'min') {
            if (bandIndex === 0) return prev;
            breakpointIndex = bandIndex - 1;
          } else {
            if (bandIndex === palette.bands.length - 1) return prev;
            breakpointIndex = bandIndex;
          }
          if (breakpointIndex < 0 || breakpointIndex >= breakpoints.length) return prev;

          breakpoints[breakpointIndex] = value;
          const clamped = clampWeatherPaletteBreakpoints(key, breakpoints, palette.bands.length);
          return {
            ...prev,
            palettes: {
              ...prev.palettes,
              [key]: {
                ...palette,
                bands: buildWeatherPaletteBands(
                  key,
                  palette.bands.map((band) => band.color),
                  clamped,
                  palette.bands.map((band) => band.visible),
                ),
              },
            },
          };
        }),
      [],
    ),
    onWeatherAddAlert: useCallback(() => {
      console.log('[weather] add alert triggered');
    }, []),
  };

  return { weatherSlice: weatherState, handlers };
}
