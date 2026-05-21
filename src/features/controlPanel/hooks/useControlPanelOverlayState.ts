import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  OverlayReloadRegistrar,
  OverlayStatusReporter,
} from '@/features/map3d';

import { loadLabelState, saveLabelState } from '@/features/labels/lib/label-persist';
import { useLabels } from '@/features/labels/hooks/useLabels';
import type { LabelCategory } from '@/features/labels/types';

import { useWind } from '@/features/weather/hooks/useWind';
import { useWeatherOverlay } from '@/features/weather/overlay/useWeatherOverlay';
import { useWindTerrainOverlay } from '@/features/weather/overlay/useWindTerrainOverlay.ts';
import { clampForecastSelection, getForecastDateForOffset } from '@/features/weather/lib/forecastTime.ts';
import { useSunlight, useShadowImage, useSunlightMap } from '@/features/sunlight';

import { DEFAULT_CONTROL_PANEL_STATE } from '../lib/defaultState';
import {
  normalizeSunlightBands,
  normalizeSunlightScaleSetting,
} from '../lib/sunlightConfig';
import { hasLegacyFeelsLikeBreakpoints, isLegacyFeelsLikePalette } from '../weather/defaultPalettes';
import {
  buildWeatherPaletteBands,
  clampWeatherPaletteBreakpoints,
  resampleWeatherPaletteBands,
  weatherPaletteMetricSpec,
} from '../lib/weatherPalette';
import type { ControlPanelPersistedState } from '../lib/persistedState';
import type {
  ControlPanelState,
  LabelKey,
  LabelsState,
  SunlightState,
  WeatherLayerKey,
  WeatherPaletteScaleSetting,
  WeatherRenderMode,
  WeatherState,
  WeatherTab,
} from '../types';

const PANEL_TO_BACKEND_LABEL: Record<LabelKey, LabelCategory | null> = {
  poiLabels: 'poi',
  roads: 'roads',
  cities: 'places',
  states: null,
  naturalParks: 'naturalParks',
  countries: 'countries',
  waterBody: 'waterBody',
};

function normalizeWeatherLayerMode(layer: WeatherState['layers'][number]): WeatherState['layers'][number] {
  if ((layer.key === 'temperature' || layer.key === 'feelsLike') && layer.mode === 'text') {
    return { ...layer, mode: 'gradient' };
  }
  if (layer.key === 'humidity' && layer.mode === '-') {
    return { ...layer, mode: 'gradient' };
  }
  return layer;
}

function toPersistedSunlightState(state: SunlightState) {
  return {
    customDateEnabled: state.customDateEnabled,
    date: state.date,
    time: state.time,
    timeScrubbing: state.timeScrubbing,
    shadowEnabled: state.shadowEnabled,
    sunlightMapEnabled: state.sunlightMapEnabled,
    shadowOpacity: state.shadowOpacity,
    scaleSetting: state.scaleSetting,
    bands: structuredClone(state.bands),
    trajectoryEnabled: state.trajectoryEnabled,
  };
}

function isValidClockTime(value: string): boolean {
  return /^\d{2}:\d{2}$/u.test(value);
}

function isNightTime(value: string, sunrise: string, sunset: string): boolean {
  if (!isValidClockTime(value) || !isValidClockTime(sunrise) || !isValidClockTime(sunset)) {
    return false;
  }

  return value < sunrise || value > sunset;
}

interface UseControlPanelOverlayStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
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

interface OverlayStateResult {
  slices: Pick<ControlPanelState, 'labels' | 'weather' | 'wind' | 'snow' | 'sunlight'>;
  handlers: OverlayHandlers;
}

export function useControlPanelOverlayState({
  map,
  isMapLoaded,
  initialControlPanel,
  updateProjectControlPanel,
  onWeatherOverlayStatusChange,
  onWeatherOverlayReloadChange,
  onWindOverlayStatusChange,
  onWindOverlayReloadChange,
  onShadowOverlayStatusChange,
  onShadowOverlayReloadChange,
  onSunlightMapOverlayStatusChange,
  onSunlightMapOverlayReloadChange,
}: UseControlPanelOverlayStateArgs): OverlayStateResult {
  const [labelBackend, setLabelBackend] = useState(
    () => initialControlPanel.labelsState?.backend ?? loadLabelState(),
  );
  const [labelsEnabled, setLabelsEnabled] = useState(initialControlPanel.toggles.labelsEnabled);
  const [statesUiToggle, setStatesUiToggle] = useState(
    initialControlPanel.labelsState?.statesUiEnabled ?? true,
  );

  const effectiveLabelState = useMemo(() => {
    if (labelsEnabled) return labelBackend;
    const next = { ...labelBackend };
    for (const key of Object.keys(next) as LabelCategory[]) next[key] = false;
    return next;
  }, [labelBackend, labelsEnabled]);

  useLabels(map, isMapLoaded, effectiveLabelState);

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

  const [windEnabled, setWindEnabled] = useState(initialControlPanel.toggles.windEnabled);
  const [windSelection, setWindSelection] = useState(() => {
    const fallback = DEFAULT_CONTROL_PANEL_STATE.wind;
    const initial = initialControlPanel.wind ?? fallback;
    const selection = clampForecastSelection({
      date: initial.date,
      time: initial.time,
      forecastDay: initial.forecastDay,
    });
    return {
      ...selection,
      particlesEnabled: initial.particlesEnabled ?? fallback.particlesEnabled,
      terrainOverlayEnabled: initial.terrainOverlayEnabled ?? fallback.terrainOverlayEnabled,
    };
  });
  const windState = useWind(
    isMapLoaded ? map : null,
    windEnabled && (windSelection.particlesEnabled || windSelection.terrainOverlayEnabled),
    windSelection,
    {
      particlesEnabled: windSelection.particlesEnabled,
      statusReporter: onWindOverlayStatusChange,
      registerReload: onWindOverlayReloadChange,
    },
  );
  useWindTerrainOverlay(
    isMapLoaded ? map : null,
    isMapLoaded,
    windEnabled && windSelection.terrainOverlayEnabled,
    windSelection,
  );

  const [snowEnabled, setSnowEnabled] = useState(initialControlPanel.toggles.snowEnabled);
  const [sunlightState, setSunlightState] = useState<SunlightState>(() => {
    const persistedSunlight: Partial<NonNullable<ControlPanelPersistedState['sunlight']>> =
      initialControlPanel.sunlight ?? {};
    const hasSunlightMapEnabled = typeof persistedSunlight.sunlightMapEnabled === 'boolean';
    const legacyMapToggle =
      typeof persistedSunlight.shadowEnabled === 'boolean'
        ? persistedSunlight.shadowEnabled
        : DEFAULT_CONTROL_PANEL_STATE.sunlight.sunlightMapEnabled;
    const initial = {
      ...DEFAULT_CONTROL_PANEL_STATE.sunlight,
      ...persistedSunlight,
      enabled: initialControlPanel.toggles.sunlightEnabled,
      shadowEnabled: hasSunlightMapEnabled
        ? (persistedSunlight.shadowEnabled ?? DEFAULT_CONTROL_PANEL_STATE.sunlight.shadowEnabled)
        : DEFAULT_CONTROL_PANEL_STATE.sunlight.shadowEnabled,
      sunlightMapEnabled: hasSunlightMapEnabled
        ? persistedSunlight.sunlightMapEnabled === true
        : legacyMapToggle,
    };
    const scaleSetting = normalizeSunlightScaleSetting(initial.scaleSetting);
    return {
      ...initial,
      scaleSetting,
      bands: normalizeSunlightBands(initial.bands, scaleSetting),
      trajectoryEnabled:
        typeof initial.trajectoryEnabled === 'boolean'
          ? initial.trajectoryEnabled
          : DEFAULT_CONTROL_PANEL_STATE.sunlight.trajectoryEnabled,
    };
  });

  const persistLabelsToProject = useCallback(
    (
      nextEnabled: boolean = labelsEnabled,
      nextBackend: typeof labelBackend = labelBackend,
      nextStatesUiToggle: boolean = statesUiToggle,
    ) => {
      updateProjectControlPanel((draft) => {
        draft.toggles.labelsEnabled = nextEnabled;
        draft.labelsState = {
          backend: structuredClone(nextBackend),
          statesUiEnabled: nextStatesUiToggle,
        };
      });
    },
    [labelBackend, labelsEnabled, statesUiToggle, updateProjectControlPanel],
  );

  const persistSunlightToProject = useCallback(
    (nextSunlightState: SunlightState) => {
      updateProjectControlPanel((draft) => {
        draft.toggles.sunlightEnabled = nextSunlightState.enabled;
        draft.sunlight = structuredClone(toPersistedSunlightState(nextSunlightState));
      });
    },
    [updateProjectControlPanel],
  );

  useEffect(() => {
    updateProjectControlPanel((draft) => {
      draft.toggles.labelsEnabled = labelsEnabled;
      draft.labelsState = {
        backend: structuredClone(labelBackend),
        statesUiEnabled: statesUiToggle,
      };
    });
  }, [labelBackend, labelsEnabled, statesUiToggle, updateProjectControlPanel]);

  useEffect(() => {
    updateProjectControlPanel((draft) => {
      draft.toggles.windEnabled = windEnabled;
    });
  }, [updateProjectControlPanel, windEnabled]);

  useEffect(() => {
    updateProjectControlPanel((draft) => {
      draft.wind = structuredClone(windSelection);
    });
  }, [updateProjectControlPanel, windSelection]);

  useEffect(() => {
    updateProjectControlPanel((draft) => {
      draft.toggles.snowEnabled = snowEnabled;
    });
  }, [snowEnabled, updateProjectControlPanel]);

  useEffect(() => {
    updateProjectControlPanel((draft) => {
      draft.toggles.sunlightEnabled = sunlightState.enabled;
      draft.sunlight = structuredClone(toPersistedSunlightState(sunlightState));
    });
  }, [sunlightState, updateProjectControlPanel]);

  const sunlightTimes = useSunlight(isMapLoaded ? map : null, isMapLoaded, {
    enabled: sunlightState.enabled,
    date: sunlightState.date,
    time: sunlightState.time,
  });

  useShadowImage(
    isMapLoaded ? map : null,
    isMapLoaded,
    {
      enabled: sunlightState.enabled && sunlightState.shadowEnabled,
      sunAzimuthDeg: sunlightTimes.sunAzimuthDeg,
      sunAltitudeDeg: sunlightTimes.sunAltitudeDeg,
      opacity: sunlightState.shadowOpacity / 100,
      timeScrubbing: sunlightState.timeScrubbing,
    },
    {
      statusReporter: onShadowOverlayStatusChange,
      registerReload: onShadowOverlayReloadChange,
    },
  );

  useSunlightMap(
    isMapLoaded ? map : null,
    isMapLoaded,
    {
      enabled: sunlightState.enabled && sunlightState.sunlightMapEnabled,
      date: sunlightState.date,
      time: sunlightState.time,
      opacity: sunlightState.shadowOpacity / 100,
      bands: sunlightState.bands,
      timeScrubbing: sunlightState.timeScrubbing,
    },
    {
      statusReporter: onSunlightMapOverlayStatusChange,
      registerReload: onSunlightMapOverlayReloadChange,
    },
  );

  const labelsSlice = useMemo(
    () => ({
      enabled: labelsEnabled,
      state: {
        poiLabels: labelBackend.poi,
        roads: labelBackend.roads,
        cities: labelBackend.places,
        states: statesUiToggle,
        naturalParks: labelBackend.naturalParks,
        countries: labelBackend.countries,
        waterBody: labelBackend.waterBody,
      } as LabelsState,
    }),
    [labelBackend, labelsEnabled, statesUiToggle],
  );

  const sunlightSlice = useMemo(
    (): SunlightState => ({
      ...sunlightState,
      sunriseTime: sunlightTimes.sunriseTime,
      sunsetTime: sunlightTimes.sunsetTime,
    }),
    [sunlightState, sunlightTimes],
  );

  useEffect(() => {
    if (sunlightState.timeScrubbing) return;
    const nextSunsetTime = sunlightTimes.sunsetTime;
    if (!isValidClockTime(nextSunsetTime)) return;
    if (!isNightTime(sunlightState.time, sunlightTimes.sunriseTime, nextSunsetTime)) return;

    setSunlightState((prev) => {
      if (prev.timeScrubbing || prev.time === nextSunsetTime) return prev;
      const next: SunlightState = {
        ...prev,
        time: nextSunsetTime,
      };
      persistSunlightToProject(next);
      return next;
    });
  }, [persistSunlightToProject, sunlightState.time, sunlightState.timeScrubbing, sunlightTimes.sunriseTime, sunlightTimes.sunsetTime]);

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

  return {
    slices: {
      labels: labelsSlice,
      weather: weatherState,
      wind: { enabled: windEnabled, ...windSelection, ...windState },
      snow: { enabled: snowEnabled },
      sunlight: sunlightSlice,
    },
    handlers: {
      onLabelsEnabledChange: useCallback(
        (enabled: boolean) => {
          setLabelsEnabled(enabled);
          persistLabelsToProject(enabled);
        },
        [persistLabelsToProject],
      ),
      onLabelToggle: useCallback(
        (key: LabelKey, checked: boolean) => {
          if (key === 'states') {
            setStatesUiToggle(checked);
            persistLabelsToProject(labelsEnabled, labelBackend, checked);
            return;
          }
          const backendKey = PANEL_TO_BACKEND_LABEL[key];
          if (!backendKey) return;
          setLabelBackend((prev) => {
            const next = { ...prev, [backendKey]: checked };
            saveLabelState(next);
            persistLabelsToProject(labelsEnabled, next, statesUiToggle);
            return next;
          });
        },
        [labelBackend, labelsEnabled, persistLabelsToProject, statesUiToggle],
      ),
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
        (changes) =>
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
      onWindEnabledChange: useCallback(
        (enabled: boolean) => {
          setWindEnabled(enabled);
          updateProjectControlPanel((draft) => {
            draft.toggles.windEnabled = enabled;
          });
        },
        [updateProjectControlPanel],
      ),
      onWindDateChange: useCallback(
        (changes) => {
          setWindSelection((prev) => {
            const next = { ...prev, ...changes };
            const resolvedDate = changes.forecastDay != null
              ? getForecastDateForOffset(changes.forecastDay)
              : next.date;
            const resolvedSelection = clampForecastSelection({
              date: resolvedDate,
              time: next.time,
              forecastDay: next.forecastDay,
            });
            return {
              ...next,
              ...resolvedSelection,
            };
          });
        },
        [],
      ),
      onSnowEnabledChange: useCallback(
        (enabled: boolean) => {
          setSnowEnabled(enabled);
          updateProjectControlPanel((draft) => {
            draft.toggles.snowEnabled = enabled;
          });
        },
        [updateProjectControlPanel],
      ),
      onSunlightEnabledChange: useCallback(
        (enabled: boolean) => {
          setSunlightState((prev) => {
            const next: SunlightState = { ...prev, enabled };
            persistSunlightToProject(next);
            return next;
          });
        },
        [persistSunlightToProject],
      ),
      onSunlightStateChange: useCallback(
        (changes: Partial<SunlightState>) => {
          setSunlightState((prev) => {
            const next: SunlightState = {
              ...prev,
              ...changes,
              sunlightMapEnabled: changes.sunlightMapEnabled ?? prev.sunlightMapEnabled,
            };
            persistSunlightToProject(next);
            return next;
          });
        },
        [persistSunlightToProject],
      ),
    },
  };
}
