import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  altitudeBandCountFromSetting,
  buildAltitudeCategories,
  clampAltitudeBreakpoints,
} from '@/features/altitude/lib/altitude-config';
import type { AltitudeScaleSettingKey } from '@/features/altitude/types';
import type { AltitudeBand, AltitudeColorization, AltitudeScaleSetting } from '@/features/controlPanel/types';
import type { ViewerAltitudeState } from './types';

function buildAltitudeBands(
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

/** Altitude overlay of the viewer: panel state, derived bands, pushed to the renderer on every change. */
export function useAltitudeLayer(onAltitudeChange: ((state: ViewerAltitudeState) => void) | undefined) {
  const [altitudeEnabled, setAltitudeEnabled] = useState(false);
  const [altitudeColorization, setAltitudeColorization] = useState<AltitudeColorization>('gradient');
  const [altitudeScaleSetting, setAltitudeScaleSetting] = useState<AltitudeScaleSetting>('4 couleurs');
  const [altitudeOpacity, setAltitudeOpacity] = useState(20);
  const [altitudeCustomColors, setAltitudeCustomColors] = useState<Record<string, string>>({});
  const [altitudeHiddenBandIds, setAltitudeHiddenBandIds] = useState<string[]>([]);
  const [altitudeBreakpointsByCount, setAltitudeBreakpointsByCount] = useState<Record<number, number[]>>({});

  const altitudeBandCount = useMemo(
    () => altitudeBandCountFromSetting(altitudeScaleSetting),
    [altitudeScaleSetting],
  );
  const currentAltitudeBreakpoints = useMemo(
    () => altitudeBreakpointsByCount[altitudeBandCount],
    [altitudeBandCount, altitudeBreakpointsByCount],
  );
  const altitudeCategories = useMemo(
    () => buildAltitudeCategories(altitudeScaleSetting as AltitudeScaleSettingKey, altitudeCustomColors, currentAltitudeBreakpoints),
    [altitudeCustomColors, altitudeScaleSetting, currentAltitudeBreakpoints],
  );
  const altitudeHiddenIds = useMemo(() => new Set(altitudeHiddenBandIds), [altitudeHiddenBandIds]);
  const altitudeBands = useMemo(
    () => buildAltitudeBands(altitudeCategories, altitudeHiddenIds),
    [altitudeCategories, altitudeHiddenIds],
  );

  useEffect(() => {
    onAltitudeChange?.({
      enabled: altitudeEnabled,
      opacity: altitudeOpacity,
      colorization: altitudeColorization,
      scaleSetting: altitudeScaleSetting,
      bands: altitudeBands,
    });
  }, [
    onAltitudeChange,
    altitudeEnabled,
    altitudeOpacity,
    altitudeColorization,
    altitudeScaleSetting,
    altitudeBands,
  ]);

  const handleAltitudeBandBreakpointChange = useCallback(
    (bandIndex: number, field: 'min' | 'max', valueMeters: number) => {
      const count = altitudeCategories.length;
      const breakpoints = altitudeCategories.slice(1).map((cat) => cat.minMeters);

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
  );

  return {
    altitudeEnabled,
    setAltitudeEnabled,
    altitudeColorization,
    setAltitudeColorization,
    altitudeScaleSetting,
    setAltitudeScaleSetting,
    altitudeOpacity,
    setAltitudeOpacity,
    setAltitudeCustomColors,
    setAltitudeHiddenBandIds,
    altitudeBands,
    handleAltitudeBandBreakpointChange,
  };
}
