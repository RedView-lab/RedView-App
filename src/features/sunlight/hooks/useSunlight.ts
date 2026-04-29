import { useEffect, useMemo, useRef, useState } from 'react';
import type { FogSpecification, LightsSpecification, Map as MapboxMap } from 'mapbox-gl';

import { getSunPosition, resolveSunTimesForLocalDay } from '../lib/sun-calc';
import { addSunRayLayer, removeSunRayLayer, updateSunRayPosition } from '../lib/sun-ray/sun-ray-layer';
import { FOG_CONFIG } from '../../map3d/lib/mapbox.config';

/**
 * Computes real sun position from date/time and map center.
 *
 * We intentionally do NOT modulate the whole scene brightness anymore. The
 * previous fog/lightPreset cycle made the entire screen brighten/darken so much
 * that terrain shadows became hard to read. The sunlight system now keeps the
 * scene lighting visually neutral and only uses the sun position for shadow
 * direction and informational sunrise/sunset times.
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
  /** Current sun azimuth in degrees (0=N, CW). Updated on each apply. */
  sunAzimuthDeg: number;
  /** Current sun altitude in degrees (-90..+90). Updated on each apply. */
  sunAltitudeDeg: number;
}

const DEFAULT_LIGHTS: LightsSpecification[] = [
  { id: 'ambient', type: 'ambient', properties: { color: 'white', intensity: 0.34 } },
  {
    id: 'directional',
    type: 'directional',
    properties: {
      color: '#ffffff',
      intensity: 0.55,
      direction: [180, 38],
      'cast-shadows': true,
      'shadow-intensity': 0.62,
    },
  },
];

function buildLights(azimuthDeg: number, altitudeDeg: number): LightsSpecification[] {
  const clampedAltitude = Math.max(-12, Math.min(85, altitudeDeg));
  const polar = Math.min(88, Math.max(4, 90 - clampedAltitude));

  return [
    {
      id: 'ambient',
      type: 'ambient',
      properties: { color: 'white', intensity: 0.34 },
    },
    {
      id: 'directional',
      type: 'directional',
      properties: {
        color: '#ffffff',
        intensity: 0.55,
        direction: [azimuthDeg, polar],
        'cast-shadows': true,
        'shadow-intensity': 0.62,
      },
    },
  ];
}

export function useSunlight(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  opts: UseSunlightOptions,
): UseSunlightResult {
  const [times, setTimes] = useState<Pick<UseSunlightResult, 'sunriseTime' | 'sunsetTime'>>({
    sunriseTime: '--:--',
    sunsetTime: '--:--',
  });
  const [sunPos, setSunPos] = useState({ azimuthDeg: 180, altitudeDeg: 45 });

  // Stable refs so the moveend listener always sees the latest values without
  // re-subscribing on every render.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  const dateTime = useMemo(() => {
    const dt = new Date(`${opts.date}T${opts.time}:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }, [opts.date, opts.time]);

  // Recompute sunrise/sunset only when the date or map center changes.
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const applyTimes = () => {
      const center = map.getCenter();
      const lat = center.lat;
      const lon = center.lng;
      const { sunriseTime, sunsetTime } = resolveSunTimesForLocalDay(
        optsRef.current.date,
        lat,
        lon,
      );
      setTimes((prev) => (
        prev.sunriseTime === sunriseTime && prev.sunsetTime === sunsetTime
          ? prev
          : { sunriseTime, sunsetTime }
      ));
    };

    applyTimes();
    map.on('moveend', applyTimes);
    return () => {
      map.off('moveend', applyTimes);
    };
  }, [map, isMapLoaded, opts.date]);

  // Update sun position + sky on time scrubs and center changes.
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    let frameId: number | null = null;

    const applySunPosition = () => {
      frameId = null;
      const center = map.getCenter();
      const lat = center.lat;
      const lon = center.lng;

      if (!optsRef.current.enabled) return;
      const dt = new Date(`${optsRef.current.date}T${optsRef.current.time}:00`);
      if (Number.isNaN(dt.getTime())) return;

      const { azimuth, altitude } = getSunPosition(dt, lat, lon);
      // NOTE: do NOT wrap this in startTransition. Time-slider scrubs emit a
      // continuous stream of urgent state updates from the parent; if this is
      // a transition, React keeps interrupting it and `sunPos` never commits.
      // That makes downstream consumers (cast-shadow overlay, sun-disk layer)
      // see a stale azimuth/altitude — the user-visible symptom is "shadows
      // and sun do not move when I drag the time slider".
      setSunPos((prev) => (
        Math.abs(prev.azimuthDeg - azimuth) < 0.01 && Math.abs(prev.altitudeDeg - altitude) < 0.01
          ? prev
          : { azimuthDeg: azimuth, altitudeDeg: altitude }
      ));
      updateSunRayPosition(azimuth, altitude);

      try {
        map.setLights(buildLights(azimuth, altitude));
      } catch (err) {
        console.warn('[sunlight] setLights failed', err);
      }

      try {
        map.setFog(FOG_CONFIG as FogSpecification);
      } catch (err) {
        console.warn('[sunlight] setFog failed', err);
      }
    };

    const scheduleApply = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(applySunPosition);
    };

    scheduleApply();
    map.on('moveend', scheduleApply);
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      map.off('moveend', scheduleApply);
    };
  }, [map, isMapLoaded, opts.enabled, dateTime]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const syncSunRayLayer = () => {
      if (!optsRef.current.enabled) {
        removeSunRayLayer(map);
        return;
      }
      try {
        addSunRayLayer(map);
        updateSunRayPosition(sunPos.azimuthDeg, sunPos.altitudeDeg);
      } catch (err) {
        console.warn('[sunlight] addSunRayLayer failed', err);
      }
    };

    syncSunRayLayer();
    map.on('style.load', syncSunRayLayer);
    return () => {
      map.off('style.load', syncSunRayLayer);
      removeSunRayLayer(map);
    };
  }, [map, isMapLoaded, opts.enabled, sunPos.azimuthDeg, sunPos.altitudeDeg]);

  // Restore neutral sky when the panel is disabled.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (opts.enabled) return;
    removeSunRayLayer(map);
    try {
      map.setLights(DEFAULT_LIGHTS);
    } catch {
      /* no-op */
    }
    try {
      map.setFog(FOG_CONFIG as FogSpecification);
    } catch {
      /* no-op */
    }
  }, [map, isMapLoaded, opts.enabled]);

  return { ...times, sunAzimuthDeg: sunPos.azimuthDeg, sunAltitudeDeg: sunPos.altitudeDeg };
}
