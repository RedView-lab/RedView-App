import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap, FogSpecification, LightsSpecification } from 'mapbox-gl';

import { formatHHmm, getSunPosition, getSunTimes } from '../lib/sun-calc';
import { getSkyAppearance } from '../lib/sky-appearance';

/**
 * Drives Mapbox sun + atmosphere from a date/time and the map center.
 *
 * Two complementary mechanisms are used:
 *   1. `setLights` with a directional light positioned at the real sun
 *      azimuth/altitude, with `cast-shadows: true` for Shadowmap-style
 *      terrain shadows.
 *   2. `setFog` with continuous `space-color`, `high-color`, `color`,
 *      `star-intensity` and `horizon-blend` values driven by sun altitude.
 *      The Mapbox Standard `lightPreset` config is locked to four discrete
 *      presets (dawn/day/dusk/night) and is not granular enough to keep
 *      stars hidden at 13:44 nor to fade in stars only after astronomical
 *      twilight — we drive the sky ourselves via setFog.
 *
 * Returned `sunriseTime` / `sunsetTime` are HH:mm strings in the host
 * timezone, recomputed whenever the date or the map center changes.
 *
 * Docs:
 *   - https://docs.mapbox.com/mapbox-gl-js/api/map/#map#setlights
 *   - https://docs.mapbox.com/mapbox-gl-js/style-spec/fog/
 *   - https://docs.mapbox.com/mapbox-gl-js/guides/styles/work-with-standard/
 */
export interface UseSunlightOptions {
  enabled: boolean;
  /** ISO YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
}

export interface UseSunlightResult {
  sunriseTime: string;
  sunsetTime: string;
}

const DEFAULT_FOG: FogSpecification = {
  range: [2, 20],
  color: 'rgb(225, 235, 245)',
  'high-color': 'rgb(90, 150, 230)',
  'horizon-blend': 0.02,
  'space-color': 'rgb(11, 11, 25)',
  'star-intensity': 0.5,
};

const DEFAULT_LIGHTS: LightsSpecification[] = [
  { id: 'ambient', type: 'ambient', properties: { color: 'white', intensity: 0.5 } },
  {
    id: 'directional',
    type: 'directional',
    properties: {
      color: 'white',
      intensity: 0.5,
      direction: [180, 30],
      'cast-shadows': true,
    },
  },
];

function classifyPreset(altitudeDeg: number, isMorning: boolean): 'dawn' | 'day' | 'dusk' | 'night' {
  if (altitudeDeg > 6) return 'day';
  if (altitudeDeg < -6) return 'night';
  return isMorning ? 'dawn' : 'dusk';
}

function buildLights(azimuthDeg: number, altitudeDeg: number): LightsSpecification[] {
  // Mapbox `direction` = [azimuth (deg from north, CW), polar (deg from zenith)].
  // Polar 0° = light from straight overhead; 90° = at the horizon. Clamp at
  // 88° so that when the sun is below the horizon the rake angle stays
  // grazing instead of lighting terrain from underneath.
  const polar = Math.min(88, Math.max(0, 90 - altitudeDeg));

  const sunAbove = Math.max(0, altitudeDeg);
  const directionalIntensity =
    altitudeDeg <= -6 ? 0 : Math.min(0.95, 0.15 + (sunAbove / 50) * 0.8);
  const ambientIntensity =
    altitudeDeg < -12 ? 0.1 : altitudeDeg < 0 ? 0.2 : altitudeDeg < 10 ? 0.35 : 0.5;

  // Warm color near the horizon (golden hour), neutral white at midday,
  // cool moonlight when below.
  const directionalColor =
    altitudeDeg > 10
      ? '#ffffff'
      : altitudeDeg > 0
        ? '#ffd2a6'
        : altitudeDeg > -6
          ? '#ff9560'
          : '#3a4a78';

  // Cast longer / softer shadows when the sun is low. `shadow-intensity`
  // 0..1 — higher = darker shadow.
  const shadowIntensity = altitudeDeg <= 0 ? 0 : Math.min(0.9, 0.3 + (sunAbove / 90) * 0.6);

  return [
    {
      id: 'ambient',
      type: 'ambient',
      properties: { color: 'white', intensity: ambientIntensity },
    },
    {
      id: 'directional',
      type: 'directional',
      properties: {
        color: directionalColor,
        intensity: directionalIntensity,
        direction: [azimuthDeg, polar],
        'cast-shadows': true,
        'shadow-intensity': shadowIntensity,
      },
    },
  ];
}

function buildFog(altitudeDeg: number): FogSpecification {
  const sky = getSkyAppearance(altitudeDeg);
  return {
    range: [0.5, 20],
    color: sky.color,
    'high-color': sky.highColor,
    'horizon-blend': sky.horizonBlend,
    'space-color': sky.spaceColor,
    'star-intensity': sky.starIntensity,
  };
}

export function useSunlight(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  opts: UseSunlightOptions,
): UseSunlightResult {
  const [times, setTimes] = useState<UseSunlightResult>({
    sunriseTime: '--:--',
    sunsetTime: '--:--',
  });

  // Stable refs so the moveend listener always sees the latest values without
  // re-subscribing on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const dateTime = useMemo(() => {
    const dt = new Date(`${opts.date}T${opts.time}:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }, [opts.date, opts.time]);

  // Apply lights + recompute sunrise/sunset whenever inputs change or the user
  // pans the map.
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const apply = () => {
      const center = map.getCenter();
      const lat = center.lat;
      const lon = center.lng;
      const noon = new Date(`${optsRef.current.date}T12:00:00`);
      if (!Number.isNaN(noon.getTime())) {
        const { sunrise, sunset } = getSunTimes(noon, lat, lon);
        setTimes({
          sunriseTime: formatHHmm(sunrise),
          sunsetTime: formatHHmm(sunset),
        });
      }

      if (!optsRef.current.enabled) return;
      const dt = new Date(`${optsRef.current.date}T${optsRef.current.time}:00`);
      if (Number.isNaN(dt.getTime())) return;

      const { azimuth, altitude } = getSunPosition(dt, lat, lon);
      const noonDate = new Date(`${optsRef.current.date}T12:00:00`);
      const isMorning = dt.getTime() < noonDate.getTime();
      const preset = classifyPreset(altitude, isMorning);

      try {
        map.setConfigProperty('basemap', 'lightPreset', preset);
      } catch {
        /* style may not expose config properties */
      }
      try {
        map.setLights(buildLights(azimuth, altitude));
      } catch (err) {
        console.warn('[sunlight] setLights failed', err);
      }
      try {
        map.setFog(buildFog(altitude));
      } catch (err) {
        console.warn('[sunlight] setFog failed', err);
      }
    };

    apply();
    map.on('moveend', apply);
    return () => {
      map.off('moveend', apply);
    };
  }, [map, isMapLoaded, opts.enabled, dateTime]);

  // Restore neutral lights when the panel is disabled.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (opts.enabled) return;
    try {
      map.setConfigProperty('basemap', 'lightPreset', 'day');
    } catch {
      /* no-op */
    }
    try {
      map.setLights(DEFAULT_LIGHTS);
    } catch {
      /* no-op */
    }
    try {
      map.setFog(DEFAULT_FOG);
    } catch {
      /* no-op */
    }
  }, [map, isMapLoaded, opts.enabled]);

  return times;
}
