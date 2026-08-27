import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { loadSlopeState, saveSlopeState, loadBreakpoints, saveBreakpoints } from '@/features/slope/lib/slope-persist';
import { generateDynamicCategories, clampBreakpoints, formatSlopeDegreeLabel } from '@/features/slope/lib/slope-config';
import { resolutionToSourceOptions } from '@/features/slope/lib/slope-source';
import { useSlope } from '@/features/slope/hooks/useSlope';
import type { SlopeCategory, SlopeColorMode, SlopeResolutionKey } from '@/features/slope/types';
import type { OverlayStatusReporter } from '@/features/map3d';

import type { ControlPanelPersistedState } from '../../lib/persistedState';
import type {
  SlopeBand,
  SlopeColorization,
  SlopeResolution,
  SlopeScale,
  SlopeScaleSetting,
} from '../../types';

function colorModeToPanel(mode: SlopeColorMode): SlopeColorization {
  return mode === 'step' ? 'stepped' : 'gradient';
}

function colorModeFromPanel(colorization: SlopeColorization): SlopeColorMode {
  return colorization === 'stepped' ? 'step' : 'gradient';
}

function bandCountFromSetting(setting: SlopeScaleSetting): number {
  const match = /^(\d+)/.exec(setting);
  return match ? Number(match[1]) : 10;
}

function buildSlopeBandsFromDynamic(
  categories: SlopeCategory[],
  visibilityById: Record<string, boolean>,
): SlopeBand[] {
  return categories.map((category) => ({
    id: category.id,
    percentRange: category.displayRange,
    degreeRange: `${formatSlopeDegreeLabel(category.minDeg)}° - ${formatSlopeDegreeLabel(category.maxDeg)}° (${category.label})`,
    label: `${category.displayRange} (${category.label})`,
    color: category.color,
    visible: visibilityById[category.id] ?? true,
    minDeg: category.minDeg,
    maxDeg: category.maxDeg,
  }));
}

export interface UseTerrainSlopeStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
  analysisZone: {
    key: string;
    bounds: [number, number, number, number];
    ring: number[];
  } | null;
  onSlopeOverlayStatusChange?: OverlayStatusReporter;
}

/**
 * Hook dédié à la gestion d'état et du calque de pente (slope overlay).
 * Gère la palette de couleurs dynamiques, les breakpoints personnalisés,
 * le masquage par zone d'analyse et la synchronisation avec le projet.
 */
export function useTerrainSlopeState({
  map,
  isMapLoaded,
  initialControlPanel,
  updateProjectControlPanel,
  analysisZone,
  onSlopeOverlayStatusChange,
}: UseTerrainSlopeStateArgs) {
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
    () => initialControlPanel.slopes?.scaleSetting ?? '10 couleurs',
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

  // ── Zone-gated slope overlay ─────────────────────────────────────────
  const slopeSourceOptions = useMemo(
    () => ({
      ...resolutionToSourceOptions(slopeState.resolution),
      zone: analysisZone
        ? { hash: analysisZone.key, bounds: analysisZone.bounds, ring: analysisZone.ring }
        : null,
    }),
    [analysisZone, slopeState.resolution],
  );

  useSlope(
    isMapLoaded ? map : null,
    isMapLoaded,
    Boolean(slopeState.enabled && analysisZone),
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
    slopeSourceOptions,
    onSlopeOverlayStatusChange,
  );

  useEffect(() => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_SLOPE_CACHE' });
  }, [bandCount, currentBreakpoints]);

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

  const handlers = {
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
  };

  return { slopesSlice, handlers };
}
