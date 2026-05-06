import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { loadSlopeState, saveSlopeState, loadBreakpoints, saveBreakpoints } from '@/features/slope/lib/slope-persist';
import { generateDynamicCategories, clampBreakpoints } from '@/features/slope/lib/slope-config';
import { resolutionToSourceOptions } from '@/features/slope/lib/slope-source';
import { useSlope } from '@/features/slope/hooks/useSlope';
import type { SlopeCategory, SlopeColorMode, SlopeResolutionKey } from '@/features/slope/types';

import { loadAltitudeState, saveAltitudeState } from '@/features/altitude/lib/altitude-persist';
import { buildAltitudeCategories, altitudeBandCountFromSetting, clampAltitudeBreakpoints } from '@/features/altitude/lib/altitude-config';
import { loadAltitudeBreakpoints, saveAltitudeBreakpoints } from '@/features/altitude/lib/altitude-persist';
import { useAltitude } from '@/features/altitude/hooks/useAltitude';
import type { AltitudeColorMode, AltitudeScaleSettingKey } from '@/features/altitude/types';

import type { OverlayStatusReporter } from '@/features/map3d';

import type { ControlPanelPersistedState } from '../lib/persistedState';
import type {
  AltitudeBand,
  AltitudeColorization,
  AltitudeScaleSetting,
  ControlPanelState,
  SlopeBand,
  SlopeColorization,
  SlopeResolution,
  SlopeScale,
  SlopeScaleSetting,
} from '../types';

function colorModeToPanel(mode: SlopeColorMode): SlopeColorization {
  return mode === 'step' ? 'stepped' : 'gradient';
}

function colorModeFromPanel(colorization: SlopeColorization): SlopeColorMode {
  return colorization === 'stepped' ? 'step' : 'gradient';
}

function altitudeColorModeToPanel(mode: AltitudeColorMode): AltitudeColorization {
  return mode === 'step' ? 'stepped' : 'gradient';
}

function altitudeColorModeFromPanel(colorization: AltitudeColorization): AltitudeColorMode {
  return colorization === 'stepped' ? 'step' : 'gradient';
}

function bandCountFromSetting(setting: SlopeScaleSetting): number {
  const match = /^(\d+)/.exec(setting);
  return match ? Number(match[1]) : 4;
}

function buildSlopeBandsFromDynamic(
  categories: SlopeCategory[],
  visibilityById: Record<string, boolean>,
): SlopeBand[] {
  return categories.map((category) => ({
    id: category.id,
    percentRange: category.displayRange,
    degreeRange: `${category.minDeg}° - ${category.maxDeg}° (${category.label})`,
    label: `${category.displayRange} (${category.label})`,
    color: category.color,
    visible: visibilityById[category.id] ?? true,
    minDeg: category.minDeg,
    maxDeg: category.maxDeg,
  }));
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

interface UseControlPanelTerrainStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
  onSlopeOverlayStatusChange?: OverlayStatusReporter;
  onAltitudeOverlayStatusChange?: OverlayStatusReporter;
}

export interface TerrainHandlers {
  onAltitudeEnabledChange: (enabled: boolean) => void;
  onAltitudeColorizationChange: (value: AltitudeColorization) => void;
  onAltitudeScaleSettingChange: (value: AltitudeScaleSetting) => void;
  onAltitudeOpacityChange: (value: number) => void;
  onAltitudeBandColorChange: (id: string, color: string) => void;
  onAltitudeBandVisibilityToggle: (id: string) => void;
  onAltitudeBandBreakpointChange: (bandIndex: number, field: 'min' | 'max', valueMeters: number) => void;
  onSlopesEnabledChange: (enabled: boolean) => void;
  onSlopeResolutionChange: (value: SlopeResolution) => void;
  onSlopeColorizationChange: (value: SlopeColorization) => void;
  onSlopeScaleChange: (value: SlopeScale) => void;
  onSlopeScaleSettingChange: (value: SlopeScaleSetting) => void;
  onSlopeOpacityChange: (value: number) => void;
  onSlopeBandColorChange: (id: string, color: string) => void;
  onSlopeBandVisibilityToggle: (id: string) => void;
  onSlopeBandBreakpointChange: (bandIndex: number, field: 'min' | 'max', valueDeg: number) => void;
}

interface TerrainStateResult {
  slices: Pick<ControlPanelState, 'slopes' | 'altitude'>;
  handlers: TerrainHandlers;
}

export function useControlPanelTerrainState({
  map,
  isMapLoaded,
  initialControlPanel,
  updateProjectControlPanel,
  onSlopeOverlayStatusChange,
  onAltitudeOverlayStatusChange,
}: UseControlPanelTerrainStateArgs): TerrainStateResult {
  const [slopeState, setSlopeState] = useState(() => {
    const loaded = initialControlPanel.slopes?.state ?? loadSlopeState();
    return {
      ...loaded,
      enabled: initialControlPanel.toggles.slopesEnabled ?? loaded.enabled,
    };
  });
  const [slopeBandVisibility, setSlopeBandVisibility] = useState<Record<string, boolean>>(
    () => initialControlPanel.slopes?.bandVisibility ?? {},
  );
  const [slopeScale, setSlopeScale] = useState<SlopeScale>(
    () => initialControlPanel.slopes?.scale ?? 'percent',
  );
  const [slopeScaleSetting, setSlopeScaleSetting] = useState<SlopeScaleSetting>(
    () => initialControlPanel.slopes?.scaleSetting ?? '4 couleurs',
  );
  const [slopeCustomColors, setSlopeCustomColors] = useState<Record<string, string>>(
    () => initialControlPanel.slopes?.customColors ?? {},
  );
  const [breakpointsByCount, setBreakpointsByCount] = useState<Record<number, number[]>>(() => {
    const persisted = initialControlPanel.slopes?.breakpoints ?? loadBreakpoints();
    return persisted.byCount;
  });

  const persistSlopeToProject = useCallback(
    (
      nextState: typeof slopeState,
      nextScale: SlopeScale = slopeScale,
      nextScaleSetting: SlopeScaleSetting = slopeScaleSetting,
      nextBandVisibility: Record<string, boolean> = slopeBandVisibility,
      nextCustomColors: Record<string, string> = slopeCustomColors,
      nextBreakpointsByCount: Record<number, number[]> = breakpointsByCount,
    ) => {
      updateProjectControlPanel((draft) => {
        draft.toggles.slopesEnabled = nextState.enabled;
        draft.slopes = {
          state: structuredClone(nextState),
          scale: nextScale,
          scaleSetting: nextScaleSetting,
          bandVisibility: structuredClone(nextBandVisibility),
          customColors: structuredClone(nextCustomColors),
          breakpoints: {
            bandCount: bandCountFromSetting(nextScaleSetting),
            byCount: structuredClone(nextBreakpointsByCount),
          },
        };
      });
    },
    [
      breakpointsByCount,
      slopeBandVisibility,
      slopeCustomColors,
      slopeScale,
      slopeScaleSetting,
      updateProjectControlPanel,
    ],
  );

  const persistSlope = useCallback((next: typeof slopeState) => {
    setSlopeState(next);
    saveSlopeState(next);
    persistSlopeToProject(next);
  }, [persistSlopeToProject]);

  const bandCount = useMemo(() => bandCountFromSetting(slopeScaleSetting), [slopeScaleSetting]);
  const currentBreakpoints = useMemo(() => breakpointsByCount[bandCount], [bandCount, breakpointsByCount]);
  const dynamicCategories = useMemo(
    () => generateDynamicCategories(bandCount, currentBreakpoints),
    [bandCount, currentBreakpoints],
  );
  const coloredDynamicCategories = useMemo(
    () => dynamicCategories.map((category) => ({
      ...category,
      color: slopeCustomColors[category.id] ?? category.color,
    })),
    [dynamicCategories, slopeCustomColors],
  );

  useSlope(
    isMapLoaded ? map : null,
    isMapLoaded,
    slopeState.enabled,
    slopeState.opacity,
    slopeState.colorMode,
    useMemo(
      () =>
        coloredDynamicCategories
          .filter((category) => slopeBandVisibility[category.id] === false)
          .map((category) => [category.minDeg, category.maxDeg] as [number, number]),
      [coloredDynamicCategories, slopeBandVisibility],
    ),
    coloredDynamicCategories,
    resolutionToSourceOptions(slopeState.resolution),
    onSlopeOverlayStatusChange,
  );

  useEffect(() => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_SLOPE_CACHE' });
  }, [bandCount, currentBreakpoints]);

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
      draft.toggles.slopesEnabled = slopeState.enabled;
      draft.slopes = {
        state: structuredClone(slopeState),
        scale: slopeScale,
        scaleSetting: slopeScaleSetting,
        bandVisibility: structuredClone(slopeBandVisibility),
        customColors: structuredClone(slopeCustomColors),
        breakpoints: {
          bandCount,
          byCount: structuredClone(breakpointsByCount),
        },
      };
    });
  }, [
    bandCount,
    breakpointsByCount,
    slopeBandVisibility,
    slopeCustomColors,
    slopeScale,
    slopeScaleSetting,
    slopeState,
    updateProjectControlPanel,
  ]);

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

  useAltitude(
    isMapLoaded ? map : null,
    isMapLoaded,
    altitudeState.enabled,
    altitudeState.opacity,
    altitudeState.colorMode,
    altitudeCategories,
    altitudeState.hiddenBandIds,
    onAltitudeOverlayStatusChange,
  );

  const slopesSlice = useMemo(
    () => ({
      enabled: slopeState.enabled,
      resolution: slopeState.resolution,
      colorization: colorModeToPanel(slopeState.colorMode),
      scale: slopeScale,
      scaleSetting: slopeScaleSetting,
      opacity: Math.round(slopeState.opacity * 100),
      bands: buildSlopeBandsFromDynamic(coloredDynamicCategories, slopeBandVisibility),
    }),
    [coloredDynamicCategories, slopeBandVisibility, slopeScale, slopeScaleSetting, slopeState],
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

  return {
    slices: {
      slopes: slopesSlice,
      altitude: altitudeSlice,
    },
    handlers: {
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
      onSlopesEnabledChange: useCallback(
        (enabled: boolean) => persistSlope({ ...slopeState, enabled }),
        [persistSlope, slopeState],
      ),
      onSlopeResolutionChange: useCallback(
        (value: SlopeResolution) => {
          const valid: SlopeResolutionKey[] = ['0.40m (LIDAR SURFACE)', '1m (LIDAR TERRAIN)'];
          if (!valid.includes(value as SlopeResolutionKey)) return;
          persistSlope({ ...slopeState, resolution: value as SlopeResolutionKey });
        },
        [persistSlope, slopeState],
      ),
      onSlopeColorizationChange: useCallback(
        (value: SlopeColorization) =>
          persistSlope({ ...slopeState, colorMode: colorModeFromPanel(value) }),
        [persistSlope, slopeState],
      ),
      onSlopeScaleChange: useCallback(
        (value: SlopeScale) => {
          setSlopeScale(value);
          persistSlopeToProject(slopeState, value);
        },
        [persistSlopeToProject, slopeState],
      ),
      onSlopeScaleSettingChange: useCallback(
        (value: SlopeScaleSetting) => {
          const valid: SlopeScaleSetting[] = [
            '2 couleurs',
            '3 couleurs',
            '4 couleurs',
            '6 couleurs',
            '8 couleurs',
            '10 couleurs',
          ];
          if (!valid.includes(value)) return;
          setSlopeScaleSetting(value);
          persistSlopeToProject(slopeState, slopeScale, value);
        },
        [persistSlopeToProject, slopeScale, slopeState],
      ),
      onSlopeOpacityChange: useCallback(
        (value: number) =>
          persistSlope({ ...slopeState, opacity: Math.max(0, Math.min(1, value / 100)) }),
        [persistSlope, slopeState],
      ),
      onSlopeBandColorChange: useCallback(
        (id: string, color: string) => {
          setSlopeCustomColors((prev) => {
            const next = { ...prev, [id]: color };
            persistSlopeToProject(slopeState, slopeScale, slopeScaleSetting, slopeBandVisibility, next);
            return next;
          });
        },
        [persistSlopeToProject, slopeBandVisibility, slopeScale, slopeScaleSetting, slopeState],
      ),
      onSlopeBandVisibilityToggle: useCallback(
        (id: string) => {
          setSlopeBandVisibility((prev) => {
            const next = { ...prev, [id]: prev[id] === false ? true : false };
            persistSlopeToProject(slopeState, slopeScale, slopeScaleSetting, next);
            return next;
          });
        },
        [persistSlopeToProject, slopeScale, slopeScaleSetting, slopeState],
      ),
      onSlopeBandBreakpointChange: useCallback(
        (bandIndex: number, field: 'min' | 'max', valueDeg: number) => {
          const count = dynamicCategories.length;
          const breakpoints = dynamicCategories.slice(1).map((category) => category.minDeg);

          let breakpointIndex: number;
          if (field === 'min') {
            if (bandIndex === 0) return;
            breakpointIndex = bandIndex - 1;
          } else {
            if (bandIndex === count - 1) return;
            breakpointIndex = bandIndex;
          }

          if (breakpointIndex < 0 || breakpointIndex >= breakpoints.length) return;

          breakpoints[breakpointIndex] = valueDeg;
          const clamped = clampBreakpoints(breakpoints, count);

          setBreakpointsByCount((prev) => {
            const next = { ...prev, [count]: clamped };
            saveBreakpoints({ bandCount: count, byCount: next });
            persistSlopeToProject(
              slopeState,
              slopeScale,
              slopeScaleSetting,
              slopeBandVisibility,
              slopeCustomColors,
              next,
            );
            return next;
          });
        },
        [
          dynamicCategories,
          persistSlopeToProject,
          slopeBandVisibility,
          slopeCustomColors,
          slopeScale,
          slopeScaleSetting,
          slopeState,
        ],
      ),
    },
  };
}
