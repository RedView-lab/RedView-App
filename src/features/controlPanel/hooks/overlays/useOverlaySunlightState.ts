import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { OverlayReloadRegistrar, OverlayStatusReporter } from '@/features/map3d';

import { useSunlight, useShadowImage, useSunlightMap } from '@/features/sunlight';
import { DEFAULT_CONTROL_PANEL_STATE } from '../../lib/defaultState';
import {
  normalizeSunlightBands,
  normalizeSunlightScaleSetting,
} from '../../lib/sunlightConfig';
import type { ControlPanelPersistedState } from '../../lib/persistedState';
import type { SunlightState } from '../../types';

function toPersistedSunlightState(state: SunlightState) {
  return {
    customDateEnabled: state.customDateEnabled,
    date: state.date,
    time: state.time,
    timeScrubbing: state.timeScrubbing,
    shadowEnabled: state.shadowEnabled,
    sunlightMapEnabled: state.sunlightMapEnabled,
    shadowOpacity: state.shadowOpacity,
    sunlightMapOpacity: state.sunlightMapOpacity,
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

export interface UseOverlaySunlightStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
  analysisZone: {
    key: string;
    bounds: [number, number, number, number];
    ring: number[];
  } | null;
  onShadowOverlayStatusChange?: OverlayStatusReporter;
  onShadowOverlayReloadChange?: OverlayReloadRegistrar;
  onSunlightMapOverlayStatusChange?: OverlayStatusReporter;
  onSunlightMapOverlayReloadChange?: OverlayReloadRegistrar;
}

/**
 * Hook dédié aux simulations solaires (ombres portées 3D, carte d'ensoleillement et éphémérides).
 */
export function useOverlaySunlightState({
  map,
  isMapLoaded,
  initialControlPanel,
  updateProjectControlPanel,
  analysisZone,
  onShadowOverlayStatusChange,
  onShadowOverlayReloadChange,
  onSunlightMapOverlayStatusChange,
  onSunlightMapOverlayReloadChange,
}: UseOverlaySunlightStateArgs) {
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
      draft.toggles.sunlightEnabled = sunlightState.enabled;
      draft.sunlight = structuredClone(toPersistedSunlightState(sunlightState));
    });
  }, [sunlightState, updateProjectControlPanel]);

  const sunlightTimes = useSunlight(isMapLoaded ? map : null, isMapLoaded, {
    enabled: sunlightState.enabled,
    date: sunlightState.date,
    time: sunlightState.time,
    trajectoryEnabled: sunlightState.trajectoryEnabled,
    shadowEnabled: sunlightState.shadowEnabled,
  });

  useShadowImage(
    isMapLoaded ? map : null,
    isMapLoaded,
    {
      enabled: Boolean(sunlightState.enabled && sunlightState.shadowEnabled),
      sunAzimuthDeg: sunlightTimes.sunAzimuthDeg,
      sunAltitudeDeg: sunlightTimes.sunAltitudeDeg,
      opacity: sunlightState.shadowOpacity / 100,
      timeScrubbing: sunlightState.timeScrubbing,
      analysisZone,
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
      enabled: Boolean(sunlightState.enabled && sunlightState.sunlightMapEnabled),
      date: sunlightState.date,
      time: sunlightState.time,
      observerLat: sunlightTimes.observerLat,
      observerLon: sunlightTimes.observerLon,
      observerTimeZone: sunlightTimes.observerTimeZone,
      opacity: sunlightState.sunlightMapOpacity / 100,
      bands: sunlightState.bands,
      timeScrubbing: sunlightState.timeScrubbing,
      analysisZone,
    },
    {
      statusReporter: onSunlightMapOverlayStatusChange,
      registerReload: onSunlightMapOverlayReloadChange,
    },
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

  const handlers = {
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
  };

  return { sunlightSlice, handlers };
}
