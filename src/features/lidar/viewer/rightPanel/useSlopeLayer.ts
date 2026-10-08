import { useCallback, useEffect, useMemo, useState } from 'react';
import { translateAppText } from '@/shared/i18n';
import {
  clampBreakpoints,
  formatSlopeDegreeLabel,
  generateDynamicCategories,
} from '@/features/slope/lib/slope-config';
import type {
  SlopeBand,
  SlopeColorization,
  SlopeResolution,
  SlopeScale,
  SlopeScaleSetting,
} from '@/features/controlPanel/types';
import type { ViewerSlopeState } from './types';

function bandCountFromSlopeSetting(setting: SlopeScaleSetting): number {
  const match = /^(\d+)/.exec(setting);
  return match ? Number(match[1]) : 10;
}

function buildSlopeBands(
  categories: ReturnType<typeof generateDynamicCategories>,
  visibilityById: Record<string, boolean>,
): SlopeBand[] {
  return categories.map((category) => ({
    id: category.id,
    percentRange: category.displayRange,
    degreeRange: `${formatSlopeDegreeLabel(category.minDeg)}° - ${formatSlopeDegreeLabel(category.maxDeg)}° (${translateAppText(category.label)})`,
    label: `${category.displayRange} (${translateAppText(category.label)})`,
    color: category.color,
    visible: visibilityById[category.id] ?? true,
    minDeg: category.minDeg,
    maxDeg: category.maxDeg,
  }));
}

/** Slope overlay of the viewer: panel state, derived bands, pushed to the renderer on every change. */
export function useSlopeLayer(onSlopeChange: ((state: ViewerSlopeState) => void) | undefined) {
  const [slopesEnabled, setSlopesEnabled] = useState(false);
  const [slopeResolution, setSlopeResolution] = useState<SlopeResolution>('0.40 m (LiDAR Surface IGN)');
  const [slopeColorization, setSlopeColorization] = useState<SlopeColorization>('gradient');
  const [slopeScale, setSlopeScale] = useState<SlopeScale>('degree');
  const [slopeScaleSetting, setSlopeScaleSetting] = useState<SlopeScaleSetting>('6 couleurs');
  const [slopeOpacity, setSlopeOpacity] = useState(20);
  const [slopeCustomColors, setSlopeCustomColors] = useState<Record<string, string>>({});
  const [slopeBandVisibility, setSlopeBandVisibility] = useState<Record<string, boolean>>({});
  const [slopeBreakpointsByCount, setSlopeBreakpointsByCount] = useState<Record<number, number[]>>({});

  const slopeBandCount = useMemo(() => bandCountFromSlopeSetting(slopeScaleSetting), [slopeScaleSetting]);
  const currentSlopeBreakpoints = useMemo(
    () => slopeBreakpointsByCount[slopeBandCount],
    [slopeBandCount, slopeBreakpointsByCount],
  );
  const dynamicSlopeCategories = useMemo(
    () => generateDynamicCategories(slopeBandCount, currentSlopeBreakpoints),
    [slopeBandCount, currentSlopeBreakpoints],
  );
  const coloredSlopeCategories = useMemo(
    () =>
      dynamicSlopeCategories.map((category) => ({
        ...category,
        color: slopeCustomColors[category.id] ?? category.color,
      })),
    [dynamicSlopeCategories, slopeCustomColors],
  );
  const slopeBands = useMemo(
    () => buildSlopeBands(coloredSlopeCategories, slopeBandVisibility),
    [coloredSlopeCategories, slopeBandVisibility],
  );

  useEffect(() => {
    onSlopeChange?.({
      enabled: slopesEnabled,
      opacity: slopeOpacity,
      colorization: slopeColorization,
      scale: slopeScale,
      scaleSetting: slopeScaleSetting,
      bands: slopeBands,
    });
  }, [
    onSlopeChange,
    slopesEnabled,
    slopeOpacity,
    slopeColorization,
    slopeScale,
    slopeScaleSetting,
    slopeBands,
  ]);

  const handleSlopeBandBreakpointChange = useCallback(
    (bandIndex: number, field: 'min' | 'max', valueDeg: number) => {
      const count = dynamicSlopeCategories.length;
      const breakpoints = dynamicSlopeCategories.slice(1).map((cat) => cat.minDeg);

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
      setSlopeBreakpointsByCount((prev) => ({ ...prev, [count]: clamped }));
    },
    [dynamicSlopeCategories],
  );

  return {
    slopesEnabled,
    setSlopesEnabled,
    slopeResolution,
    setSlopeResolution,
    slopeColorization,
    setSlopeColorization,
    slopeScale,
    setSlopeScale,
    slopeScaleSetting,
    setSlopeScaleSetting,
    slopeOpacity,
    setSlopeOpacity,
    setSlopeCustomColors,
    setSlopeBandVisibility,
    slopeBands,
    handleSlopeBandBreakpointChange,
  };
}
