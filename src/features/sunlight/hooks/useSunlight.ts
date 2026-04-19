import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap, LightsSpecification } from 'mapbox-gl';

import { formatHHmm, getSunPosition, getSunTimes } from '../lib/sun-calc';

/**
 * Drives Mapbox's built-in sun + atmosphere from a date/time and the map
 * center. Uses the Mapbox Standard "lightPreset" config property for
 * atmospheric mood (dawn/day/dusk/night) and `setLights` for an accurate
 * directional sun aligned with the real solar azimuth and altitude.
 *
 * Returned `sunriseTime` / `sunsetTime` are HH:mm strings in the host
 * timezone, recomputed whenever the date or map center change.
 *
 * Docs:
 *   - https://docs.mapbox.com/mapbox-gl-js/api/map/#map#setlights
 *   - https://docs.mapbox.com/mapbox-gl-js/style-spec/light/
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
  // Polar angle: 0° = sun directly overhead, 90° = sun at the horizon.
  // Clamp at 90° when the sun is below the horizon so the directional light
  // still rakes across the surface instead of lighting it from underneath.
  const polar = Math.min(90, Math.max(0, 90 - altitudeDeg));

  // Intensity ramps from ~0.1 at the horizon up to 0.85 at zenith. Below the
  // horizon we keep a faint moonlight-like contribution.
  const sunAbove = Math.max(0, altitudeDeg);
  const directionalIntensity =
    altitudeDeg <= 0 ? 0.05 : Math.min(0.85, 0.1 + (sunAbove / 60) * 0.75);
  const ambientIntensity =
    altitudeDeg < -6 ? 0.15 : altitudeDeg < 6 ? 0.3 : 0.5;

  // Warm color near the horizon (golden hour), neutral white otherwise.
  const directionalColor =
    altitudeDeg > 6
      ? '#ffffff'
      : altitudeDeg > -6
        ? '#ffb27d'
        : '#3a4a78';

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
      },
    },
  ];
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
  }, [map, isMapLoaded, opts.enabled]);

  return times;
}
