import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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

/**
 * Persistence (project document + localStorage) stays off the interaction
 * path: an opacity drag emits ~60 changes/s and every project write
 * re-renders the dashboard (~80 ms each, two writes per tick before). The map
 * follows the local state at once; one write lands when the value settles and
 * a pending one is flushed on unmount (project switch, panel teardown).
 */
const ALTITUDE_PERSIST_DELAY_MS = 250;

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

  const persistInputsRef = useRef({ altitudeState, altitudeBreakpointsByCount, updateProjectControlPanel });
  useLayoutEffect(() => {
    persistInputsRef.current = { altitudeState, altitudeBreakpointsByCount, updateProjectControlPanel };
  });
  const persistPendingRef = useRef(false);
  const flushAltitudePersist = useCallback(() => {
    if (!persistPendingRef.current) return;
    persistPendingRef.current = false;
    const { altitudeState: state, altitudeBreakpointsByCount: byCount, updateProjectControlPanel: update } = persistInputsRef.current;
    const bandCount = altitudeBandCountFromSetting(state.scaleSetting);
    saveAltitudeState(state);
    saveAltitudeBreakpoints({ bandCount, byCount });
    update((draft) => {
      draft.toggles.altitudeEnabled = state.enabled;
      draft.altitude = {
        state: structuredClone(state),
        breakpoints: { bandCount, byCount: structuredClone(byCount) },
      };
    });
  }, []);

  useEffect(() => {
    persistPendingRef.current = true;
    const timer = setTimeout(flushAltitudePersist, ALTITUDE_PERSIST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [altitudeState, altitudeBreakpointsByCount, flushAltitudePersist]);
  useEffect(() => flushAltitudePersist, [flushAltitudePersist]);

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

  // Functional updates: consecutive slider ticks never read a stale state.
  const handlers = {
    onAltitudeEnabledChange: useCallback(
      (enabled: boolean) => setAltitudeState((prev) => ({ ...prev, enabled })),
      [],
    ),
    onAltitudeColorizationChange: useCallback(
      (value: AltitudeColorization) =>
        setAltitudeState((prev) => ({ ...prev, colorMode: altitudeColorModeFromPanel(value) })),
      [],
    ),
    onAltitudeScaleSettingChange: useCallback(
      (value: AltitudeScaleSetting) => {
        const valid: AltitudeScaleSettingKey[] = ['2 couleurs', '3 couleurs', '4 couleurs', '6 couleurs'];
        if (!valid.includes(value as AltitudeScaleSettingKey)) return;
        setAltitudeState((prev) => ({ ...prev, scaleSetting: value as AltitudeScaleSettingKey }));
      },
      [],
    ),
    onAltitudeOpacityChange: useCallback(
      (value: number) =>
        setAltitudeState((prev) => ({ ...prev, opacity: Math.max(0, Math.min(1, value / 100)) })),
      [],
    ),
    onAltitudeBandColorChange: useCallback(
      (id: string, color: string) =>
        setAltitudeState((prev) => ({ ...prev, customColors: { ...prev.customColors, [id]: color } })),
      [],
    ),
    onAltitudeBandVisibilityToggle: useCallback(
      (id: string) =>
        setAltitudeState((prev) => {
          const hidden = new Set(prev.hiddenBandIds);
          if (hidden.has(id)) hidden.delete(id);
          else hidden.add(id);
          return { ...prev, hiddenBandIds: Array.from(hidden) };
        }),
      [],
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
        setAltitudeBreakpointsByCount((prev) => ({ ...prev, [count]: clamped }));
      },
      [altitudeCategories],
    ),
  };

  return { altitudeSlice, handlers };
}
