import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import {
  buildAltitudeCategories,
  altitudeBandCountFromSetting,
  clampAltitudeBreakpoints,
  loadAltitudeState,
  saveAltitudeState,
  loadAltitudeBreakpoints,
  saveAltitudeBreakpoints,
  useAltitude,
  type AltitudeColorMode,
  type AltitudeScaleSettingKey,
  type AltitudeTileSourceOptions,
} from '@/features/altitude';
import type { OverlayStatusReporter } from '@/features/map3d';
import {
  getActiveDem3dQuality,
  subscribeDem3dQuality,
} from '@/features/map3d/lib/dem3dQualityBus';
import {
  getActiveDemProfilePreference,
  subscribeDemProfilePreference,
} from '@/features/map3d/lib/demProfileBus';

import type { ControlPanelPersistedState } from '../../lib/persistedState';
import type {
  AltitudeBand,
  AltitudeColorization,
  AltitudeScaleSetting,
} from '../../types';

function altitudeColorModeToPanel(mode: AltitudeColorMode): AltitudeColorization {
  return mode === 'step' ? 'stepped' : 'gradient';
}

function altitudeColorModeFromPanel(colorization: AltitudeColorization): AltitudeColorMode {
  return colorization === 'stepped' ? 'step' : 'gradient';
}

function buildAltitudeBandsFromDynamic(
  categories: ReturnType<typeof buildAltitudeCategories>,
  hiddenIds: Set<string>,
): AltitudeBand[] {
  return categories.map((category) => ({
    id: category.id,
    label: category.displayRange,
    color: category.color,
    visible: !hiddenIds.has(category.id),
    minMeters: category.minMeters,
    maxMeters: category.maxMeters,
  }));
}

export interface UseTerrainAltitudeStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
  analysisZone?: unknown;
  onAltitudeOverlayStatusChange?: OverlayStatusReporter;
}

/**
 * Hook dédié à la gestion d'état et du calque d'altitude (altitude overlay).
 * Gère les tranches altimétriques dynamiques et la persistance des paramètres au sein du projet.
 */
export function useTerrainAltitudeState({
  map,
  isMapLoaded,
  initialControlPanel,
  updateProjectControlPanel,
  onAltitudeOverlayStatusChange,
}: UseTerrainAltitudeStateArgs) {
  const [altitudeState, setAltitudeState] = useState(() => {
    const loaded = initialControlPanel.altitude?.state ?? loadAltitudeState();
    return {
      ...loaded,
      enabled: initialControlPanel.toggles.altitudeEnabled ?? loaded.enabled,
    };
  });
  const [altitudeBreakpointsByCount, setAltitudeBreakpointsByCount] = useState<Record<number, number[]>>(() => {
    const persisted = initialControlPanel.altitude?.breakpoints ?? loadAltitudeBreakpoints();
    return persisted.byCount;
  });

  const persistAltitudeToProject = useCallback(
    (
      nextState: typeof altitudeState,
      nextBreakpointsByCount: Record<number, number[]> = altitudeBreakpointsByCount,
    ) => {
      updateProjectControlPanel((draft) => {
        draft.toggles.altitudeEnabled = nextState.enabled;
        draft.altitude = {
          state: structuredClone(nextState),
          breakpoints: {
            bandCount: altitudeBandCountFromSetting(nextState.scaleSetting),
            byCount: structuredClone(nextBreakpointsByCount),
          },
        };
      });
    },
    [altitudeBreakpointsByCount, updateProjectControlPanel],
  );

  const persistAltitude = useCallback((next: typeof altitudeState) => {
    setAltitudeState(next);
    saveAltitudeState(next);
    persistAltitudeToProject(next);
  }, [persistAltitudeToProject]);

  const altitudeBandCount = useMemo(
    () => altitudeBandCountFromSetting(altitudeState.scaleSetting),
    [altitudeState.scaleSetting],
  );
  const currentAltitudeBreakpoints = useMemo(
    () => altitudeBreakpointsByCount[altitudeBandCount],
    [altitudeBandCount, altitudeBreakpointsByCount],
  );
  const altitudeCategories = useMemo(
    () => buildAltitudeCategories(
      altitudeState.scaleSetting,
      altitudeState.customColors,
      currentAltitudeBreakpoints,
    ),
    [altitudeState.customColors, altitudeState.scaleSetting, currentAltitudeBreakpoints],
  );
  const altitudeHiddenIds = useMemo(
    () => new Set(altitudeState.hiddenBandIds),
    [altitudeState.hiddenBandIds],
  );

  useEffect(() => {
    updateProjectControlPanel((draft) => {
      draft.toggles.altitudeEnabled = altitudeState.enabled;
      draft.altitude = {
        state: structuredClone(altitudeState),
        breakpoints: {
          bandCount: altitudeBandCount,
          byCount: structuredClone(altitudeBreakpointsByCount),
        },
      };
    });
  }, [
    altitudeBandCount,
    altitudeBreakpointsByCount,
    altitudeState,
    updateProjectControlPanel,
  ]);

  // ── Altitude source follows the 3D terrain DEM ───────────────────────
  // The overlay re-reads the exact tiles the terrain streams (AWS Terrarium
  // in fast-30m, SW DEM cache for the active profile in HD) — never a second
  // DEM pipeline.
  const dem3dQuality = useSyncExternalStore(subscribeDem3dQuality, getActiveDem3dQuality);
  const demProfile = useSyncExternalStore(subscribeDemProfilePreference, getActiveDemProfilePreference);
  const altitudeSourceOptions = useMemo<AltitudeTileSourceOptions>(
    () => ({ zone: null, quality: dem3dQuality, profile: demProfile }),
    [dem3dQuality, demProfile],
  );

  useAltitude(
    isMapLoaded ? map : null,
    isMapLoaded,
    Boolean(altitudeState.enabled),
    altitudeState.opacity,
    altitudeState.colorMode,
    altitudeCategories,
    altitudeState.hiddenBandIds,
    altitudeSourceOptions,
    onAltitudeOverlayStatusChange,
  );

  const altitudeSlice = useMemo(
    () => ({
      enabled: altitudeState.enabled,
      colorization: altitudeColorModeToPanel(altitudeState.colorMode),
      scaleSetting: altitudeState.scaleSetting,
      opacity: Math.round(altitudeState.opacity * 100),
      bands: buildAltitudeBandsFromDynamic(altitudeCategories, altitudeHiddenIds),
    }),
    [altitudeCategories, altitudeHiddenIds, altitudeState],
  );

  const handlers = {
    onAltitudeEnabledChange: useCallback(
      (enabled: boolean) => persistAltitude({ ...altitudeState, enabled }),
      [altitudeState, persistAltitude],
    ),
    onAltitudeColorizationChange: useCallback(
      (value: AltitudeColorization) =>
        persistAltitude({ ...altitudeState, colorMode: altitudeColorModeFromPanel(value) }),
      [altitudeState, persistAltitude],
    ),
    onAltitudeScaleSettingChange: useCallback(
      (value: AltitudeScaleSetting) => {
        const valid: AltitudeScaleSettingKey[] = ['2 couleurs', '3 couleurs', '4 couleurs', '6 couleurs'];
        if (!valid.includes(value as AltitudeScaleSettingKey)) return;
        persistAltitude({ ...altitudeState, scaleSetting: value as AltitudeScaleSettingKey });
      },
      [altitudeState, persistAltitude],
    ),
    onAltitudeOpacityChange: useCallback(
      (value: number) =>
        persistAltitude({
          ...altitudeState,
          opacity: Math.max(0, Math.min(1, value / 100)),
        }),
      [altitudeState, persistAltitude],
    ),
    onAltitudeBandColorChange: useCallback(
      (id: string, color: string) =>
        persistAltitude({
          ...altitudeState,
          customColors: { ...altitudeState.customColors, [id]: color },
        }),
      [altitudeState, persistAltitude],
    ),
    onAltitudeBandVisibilityToggle: useCallback(
      (id: string) => {
        const hidden = new Set(altitudeState.hiddenBandIds);
        if (hidden.has(id)) hidden.delete(id);
        else hidden.add(id);
        persistAltitude({ ...altitudeState, hiddenBandIds: Array.from(hidden) });
      },
      [altitudeState, persistAltitude],
    ),
    onAltitudeBandBreakpointChange: useCallback(
      (bandIndex: number, field: 'min' | 'max', valueMeters: number) => {
        const count = altitudeCategories.length;
        const breakpoints = altitudeCategories.slice(1).map((category) => category.minMeters);

        let breakpointIndex: number;
        if (field === 'min') {
          if (bandIndex === 0) return;
          breakpointIndex = bandIndex - 1;
        } else {
          if (bandIndex === count - 1) return;
          breakpointIndex = bandIndex;
        }

        if (breakpointIndex < 0 || breakpointIndex >= breakpoints.length) return;

        breakpoints[breakpointIndex] = valueMeters;
        const clamped = clampAltitudeBreakpoints(breakpoints, count);

        setAltitudeBreakpointsByCount((prev) => {
          const next = { ...prev, [count]: clamped };
          saveAltitudeBreakpoints({ bandCount: count, byCount: next });
          persistAltitudeToProject(altitudeState, next);
          return next;
        });
      },
      [altitudeCategories, altitudeState, persistAltitudeToProject],
    ),
  };

  return { altitudeSlice, handlers };
}
