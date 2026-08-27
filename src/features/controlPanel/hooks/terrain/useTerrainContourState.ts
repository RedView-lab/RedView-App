import { useCallback, useMemo, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { useContourLines } from '@/features/contourLines/hooks/useContourLines';
import { DEFAULT_CONTROL_PANEL_STATE } from '../../lib/defaultState';
import type { ControlPanelPersistedState } from '../../lib/persistedState';
import type { BasemapId, ContourIntervalSetting } from '../../types';

function contourIntervalMetersFromSetting(setting: ContourIntervalSetting): number {
  const match = /^(\d+)/.exec(setting);
  return match ? Number(match[1]) : 200;
}

export interface UseTerrainContourStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  activeBasemapId: BasemapId;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
}

/**
 * Hook dédié à la gestion d'état des courbes de niveau (contour lines).
 * Gère l'intervalle altimétrique, l'opacité et l'affichage selon le fond de carte actif.
 */
export function useTerrainContourState({
  map,
  isMapLoaded,
  activeBasemapId,
  initialControlPanel,
  updateProjectControlPanel,
}: UseTerrainContourStateArgs) {
  const [contourLinesEnabled, setContourLinesEnabled] = useState(
    () => initialControlPanel.toggles.contourLinesEnabled ?? DEFAULT_CONTROL_PANEL_STATE.contourLines.enabled,
  );
  const [contourLinesInterval, setContourLinesInterval] = useState<ContourIntervalSetting>(
    () => initialControlPanel.contourLines?.interval ?? DEFAULT_CONTROL_PANEL_STATE.contourLines.interval,
  );
  const [contourLinesOpacity, setContourLinesOpacity] = useState(
    () => initialControlPanel.contourLines?.opacity ?? DEFAULT_CONTROL_PANEL_STATE.contourLines.opacity,
  );
  const contourLinesAvailable = activeBasemapId === 'topographic';

  useContourLines(
    isMapLoaded ? map : null,
    isMapLoaded,
    contourLinesEnabled,
    Math.max(0, Math.min(1, contourLinesOpacity / 100)),
    contourIntervalMetersFromSetting(contourLinesInterval),
    contourLinesAvailable,
  );

  const contourLinesSlice = useMemo(
    () => ({
      enabled: contourLinesEnabled,
      interval: contourLinesInterval,
      opacity: contourLinesOpacity,
      available: contourLinesAvailable,
    }),
    [contourLinesAvailable, contourLinesEnabled, contourLinesInterval, contourLinesOpacity],
  );

  const handlers = {
    onContourLinesEnabledChange: useCallback(
      (enabled: boolean) => {
        setContourLinesEnabled(enabled);
        updateProjectControlPanel((draft) => {
          draft.toggles.contourLinesEnabled = enabled;
        });
      },
      [updateProjectControlPanel],
    ),
    onContourLinesIntervalChange: useCallback(
      (value: ContourIntervalSetting) => {
        setContourLinesInterval(value);
        updateProjectControlPanel((draft) => {
          if (!draft.contourLines) {
            draft.contourLines = {
              interval: value,
              opacity: contourLinesOpacity,
            };
          } else {
            draft.contourLines.interval = value;
          }
        });
      },
      [contourLinesOpacity, updateProjectControlPanel],
    ),
    onContourLinesOpacityChange: useCallback(
      (value: number) => {
        const clamped = Math.max(0, Math.min(100, Math.round(value)));
        setContourLinesOpacity(clamped);
        updateProjectControlPanel((draft) => {
          if (!draft.contourLines) {
            draft.contourLines = {
              interval: contourLinesInterval,
              opacity: clamped,
            };
          } else {
            draft.contourLines.opacity = clamped;
          }
        });
      },
      [contourLinesInterval, updateProjectControlPanel],
    ),
  };

  return { contourLinesSlice, handlers };
}
