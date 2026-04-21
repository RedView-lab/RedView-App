import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type { FogSpecification, Map as MapboxMap } from 'mapbox-gl';

import { formatHHmm, getSunPosition, getSunTimes } from '../lib/sun-calc';
import { getSkyAppearance } from '../lib/sky-appearance';
import { FOG_CONFIG } from '../../map3d/lib/mapbox.config';

/**
 * Computes real sun position from date/time and map center.
 *
 * We intentionally do NOT modulate the whole scene brightness anymore. The
 * previous fog/lightPreset cycle made the entire screen brighten/darken so much
 * that terrain shadows became hard to read. The sunlight system now focuses on
 * solar position, sunrise/sunset times, and a restrained
 * sky-only fog so dawn/dusk remains visible without washing the ground.
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseRgb(rgb: string): [number, number, number] {
  const match = rgb.match(/\d+/g);
  if (!match || match.length < 3) return [0, 0, 0];
  return [Number(match[0]), Number(match[1]), Number(match[2])];
}

function mixColor(a: string, b: string, t: number): string {
  const mix = clamp01(t);
  const [ar, ag, ab] = parseRgb(a);
  const [br, bg, bb] = parseRgb(b);
  const r = Math.round(ar + (br - ar) * mix);
  const g = Math.round(ag + (bg - ag) * mix);
  const bCh = Math.round(ab + (bb - ab) * mix);
  return `rgb(${r}, ${g}, ${bCh})`;
}

function buildSkyOnlyFog(altitudeDeg: number): FogSpecification {
  const sky = getSkyAppearance(altitudeDeg);
  const twilightFactor = clamp01((12 - Math.max(altitudeDeg, -18)) / 30);

  return {
    ...FOG_CONFIG,
    range: [12, 20],
    color: mixColor(FOG_CONFIG.color, sky.color, 0.18 + twilightFactor * 0.12),
    'high-color': mixColor(FOG_CONFIG['high-color'], sky.highColor, 0.72),
    'space-color': sky.spaceColor,
    'star-intensity': sky.starIntensity,
    'horizon-blend': Math.min(0.018, 0.006 + sky.horizonBlend * 0.18),
  };
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
      const noon = new Date(`${optsRef.current.date}T12:00:00`);
      if (!Number.isNaN(noon.getTime())) {
        const { sunrise, sunset } = getSunTimes(noon, lat, lon);
        const nextSunrise = formatHHmm(sunrise);
        const nextSunset = formatHHmm(sunset);
        setTimes((prev) => (
          prev.sunriseTime === nextSunrise && prev.sunsetTime === nextSunset
            ? prev
            : { sunriseTime: nextSunrise, sunsetTime: nextSunset }
        ));
      }
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
      startTransition(() => {
        setSunPos((prev) => (
          Math.abs(prev.azimuthDeg - azimuth) < 0.01 && Math.abs(prev.altitudeDeg - altitude) < 0.01
            ? prev
            : { azimuthDeg: azimuth, altitudeDeg: altitude }
        ));
      });

      try {
        map.setFog(buildSkyOnlyFog(altitude));
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

  // Restore neutral sky when the panel is disabled.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (opts.enabled) return;
    try {
      map.setFog(FOG_CONFIG as FogSpecification);
    } catch {
      /* no-op */
    }
  }, [map, isMapLoaded, opts.enabled]);

  return { ...times, sunAzimuthDeg: sunPos.azimuthDeg, sunAltitudeDeg: sunPos.altitudeDeg };
}
