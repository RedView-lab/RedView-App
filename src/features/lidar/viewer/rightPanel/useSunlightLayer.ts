import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildDefaultSunlightBands,
  normalizeSunlightScaleSetting,
  resampleSunlightBands,
} from '@/features/controlPanel/lib/sunlightConfig';
import { resolveSunTimesForLocalDay } from '@/features/sunlight/lib/sun-calc';
import { getTimeZoneForCoordinates } from '@/features/lidar/lib/coordConvert';
import type { SunlightState } from '@/features/controlPanel/types';

/**
 * Couche d'ensoleillement du viewer : état du panneau, lever/coucher du soleil
 * du jour choisi au centre de la scène, poussés au renderer à chaque changement.
 */
export function useSunlightLayer(
  onSunlightChange: ((state: SunlightState) => void) | undefined,
  centerLon: number | undefined,
  centerLat: number | undefined,
  timeZone: string | undefined,
) {
  const localTimeZone = useMemo(() => {
    if (timeZone) return timeZone;
    if (centerLon != null && centerLat != null) {
      return getTimeZoneForCoordinates(centerLon, centerLat);
    }
    return 'Europe/Paris';
  }, [timeZone, centerLon, centerLat]);

  const [sunlightState, setSunlightState] = useState<SunlightState>(() => {
    const today = new Date().toISOString().slice(0, 10);
    const initialTz =
      timeZone ?? (centerLon != null && centerLat != null ? getTimeZoneForCoordinates(centerLon, centerLat) : 'Europe/Paris');
    const times =
      centerLat != null && centerLon != null
        ? resolveSunTimesForLocalDay(today, centerLat, centerLon, initialTz)
        : { sunriseTime: '06:45', sunsetTime: '20:30' };
    return {
      enabled: false,
      customDateEnabled: true,
      date: today,
      time: '12:00',
      timeScrubbing: false,
      sunriseTime: times.sunriseTime,
      sunsetTime: times.sunsetTime,
      shadowEnabled: true,
      sunlightMapEnabled: true,
      shadowOpacity: 50,
      sunlightMapOpacity: 50,
      scaleSetting: '4 couleurs',
      bands: buildDefaultSunlightBands('4 couleurs'),
      trajectoryEnabled: true,
    };
  });
  const [sunlightMapExpanded, setSunlightMapExpanded] = useState(true);

  // Lever et coucher du jour choisi au centre de la scène.
  const sunTimes = useMemo(
    () => (centerLat == null || centerLon == null
      ? null
      : resolveSunTimesForLocalDay(sunlightState.date, centerLat, centerLon, localTimeZone)),
    [sunlightState.date, centerLat, centerLon, localTimeZone],
  );
  if (sunTimes && (sunTimes.sunriseTime !== sunlightState.sunriseTime || sunTimes.sunsetTime !== sunlightState.sunsetTime)) {
    setSunlightState((prev) => ({
      ...prev,
      sunriseTime: sunTimes.sunriseTime,
      sunsetTime: sunTimes.sunsetTime,
    }));
  }

  useEffect(() => {
    onSunlightChange?.(sunlightState);
  }, [onSunlightChange, sunlightState]);

  const handleSunlightStateChange = useCallback((changes: Partial<SunlightState>) => {
    setSunlightState((prev) => {
      let nextBands = prev.bands;
      let nextScaleSetting = prev.scaleSetting;

      if (changes.scaleSetting && changes.scaleSetting !== prev.scaleSetting) {
        nextScaleSetting = normalizeSunlightScaleSetting(changes.scaleSetting);
        nextBands = resampleSunlightBands(prev.bands, nextScaleSetting);
      } else if (changes.bands) {
        nextBands = changes.bands;
      }

      let sunriseTime = prev.sunriseTime;
      let sunsetTime = prev.sunsetTime;
      if (changes.date && changes.date !== prev.date && centerLat != null && centerLon != null) {
        const times = resolveSunTimesForLocalDay(changes.date, centerLat, centerLon, localTimeZone);
        sunriseTime = times.sunriseTime;
        sunsetTime = times.sunsetTime;
      }

      return {
        ...prev,
        ...changes,
        sunriseTime,
        sunsetTime,
        scaleSetting: nextScaleSetting,
        bands: nextBands,
      };
    });
  }, [centerLat, centerLon, localTimeZone]);

  return {
    localTimeZone,
    sunlightState,
    setSunlightState,
    sunlightMapExpanded,
    setSunlightMapExpanded,
    handleSunlightStateChange,
  };
}
