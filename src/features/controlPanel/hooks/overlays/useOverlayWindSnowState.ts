import { useCallback, useEffect, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { OverlayReloadRegistrar, OverlayStatusReporter } from '@/features/map3d';

import { useWind } from '@/features/weather/hooks/useWind';
import { useWindTerrainOverlay } from '@/features/weather/overlay/useWindTerrainOverlay.ts';
import { clampForecastSelection, getForecastDateForOffset } from '@/features/weather/lib/forecastTime.ts';

import { DEFAULT_CONTROL_PANEL_STATE } from '../../lib/defaultState';
import type { ControlPanelPersistedState } from '../../lib/persistedState';
import type { ControlPanelState } from '../../types';

export interface UseOverlayWindSnowStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
  onWindOverlayStatusChange?: OverlayStatusReporter;
  onWindOverlayReloadChange?: OverlayReloadRegistrar;
}

/**
 * Hook dédié aux simulations d'animation de vent (particules & drapeaux de terrain) et de neige.
 */
export function useOverlayWindSnowState({
  map,
  isMapLoaded,
  initialControlPanel,
  updateProjectControlPanel,
  onWindOverlayStatusChange,
  onWindOverlayReloadChange,
}: UseOverlayWindSnowStateArgs) {
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

  const windSlice = {
    enabled: windEnabled,
    ...windSelection,
    ...windState,
  };

  const snowSlice = {
    enabled: snowEnabled,
  };

  const handlers = {
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
      (changes: Partial<Pick<ControlPanelState['wind'], 'date' | 'time' | 'forecastDay' | 'particlesEnabled' | 'terrainOverlayEnabled'>>) => {
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
  };

  return { windSlice, snowSlice, handlers };
}
