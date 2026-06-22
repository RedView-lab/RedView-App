import { useEffect, useMemo, useRef, useState } from 'react';
import type { FogSpecification, LightsSpecification, Map as MapboxMap } from 'mapbox-gl';

import {
  getSunPositionForLocalDateTime,
  resolveSunTimesForLocalDay,
} from '../lib/sun-calc';
import {
  resolveSunObserverPoint,
  sameSunObserverPoint,
  type SunObserverPoint,
} from '../lib/observerPoint';
import { addSunRayLayer, removeSunRayLayer, updateSunRayPosition } from '../lib/sun-ray/sun-ray-layer';
import { FOG_CONFIG } from '../../map3d/lib/mapbox.config';
import { OPENMETEO_FORECAST_URL } from '@/features/weather/lib/openMeteoConfig';

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
  trajectoryEnabled: boolean;
  /**
   * Real-time GPU shadow casting on 3D geometry (Mapbox `cast-shadows`).
   * This is the expensive path: on styles with fill-extrusion buildings (e.g.
   * the light "Standard" basemap) it forces a shadow-map pass over every
   * extruded building each frame and tanks FPS in cities. Tied to the same
   * "Ombres" toggle as the DEM ray-traced overlay so the user has one knob.
   */
  shadowEnabled: boolean;
}

export interface UseSunlightResult {
  sunriseTime: string;
  sunsetTime: string;
  /** Current sun azimuth in degrees (0=N, CW). Updated on each apply. */
  sunAzimuthDeg: number;
  /** Current sun altitude in degrees (-90..+90). Updated on each apply. */
  sunAltitudeDeg: number;
  observerLat: number | null;
  observerLon: number | null;
  observerTimeZone: string | null;
}

interface TimeZoneLookupPayload {
  timezone?: string | null;
}

const timeZoneLookupCache = new Map<string, Promise<string | null>>();

function pointLookupKey(point: Pick<SunObserverPoint, 'lat' | 'lng'>): string {
  return `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
}

function getHostTimeZone(): string | null {
  const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

async function lookupTimeZoneForPoint(point: Pick<SunObserverPoint, 'lat' | 'lng'>): Promise<string | null> {
  const key = pointLookupKey(point);
  const existing = timeZoneLookupCache.get(key);
  if (existing) return existing;

  const request = (() => {
    const target = new URL(OPENMETEO_FORECAST_URL, window.location.origin);
    target.searchParams.set('latitude', String(point.lat));
    target.searchParams.set('longitude', String(point.lng));
    target.searchParams.set('timezone', 'auto');
    target.searchParams.set('current', 'is_day');
    target.searchParams.set('forecast_days', '1');

    return fetch(target.toString())
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`timezone lookup failed with ${response.status}`);
      }
      const payload = (await response.json()) as TimeZoneLookupPayload;
      return typeof payload.timezone === 'string' && payload.timezone.trim()
        ? payload.timezone
        : null;
    })
    .catch((error) => {
      console.warn('[sunlight] timezone lookup failed, falling back to host timezone', error);
      return getHostTimeZone();
    });
  })();

  timeZoneLookupCache.set(key, request);
  return request;
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
      'cast-shadows': false,
      'shadow-intensity': 0,
    },
  },
];

function buildLights(azimuthDeg: number, altitudeDeg: number, castShadows: boolean): LightsSpecification[] {
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
        // `cast-shadows` is the single most expensive Mapbox light property
        // on styles with fill-extrusion 3D buildings (light "Standard" basemap):
        // it triggers a per-frame shadow-map render over every extruded
        // building, which collapses FPS to single digits in dense cities.
        // Gated by the user-facing "Ombres" toggle so it can be turned off.
        'cast-shadows': castShadows,
        'shadow-intensity': castShadows ? 0.62 : 0,
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
  const [observerPoint, setObserverPoint] = useState<SunObserverPoint | null>(null);
  const [observerTimeZoneState, setObserverTimeZoneState] = useState<{
    key: string;
    timeZone: string | null;
  } | null>(null);

  // Stable refs so the moveend listener always sees the latest values without
  // re-subscribing on every render.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  const observerPointKey = useMemo(
    () => (observerPoint ? pointLookupKey(observerPoint) : null),
    [observerPoint],
  );
  const observerTimeZone = observerTimeZoneState?.key === observerPointKey
    ? observerTimeZoneState.timeZone
    : null;
  const effectiveObserverTimeZone = observerTimeZone ?? getHostTimeZone();

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const syncObserverPoint = () => {
      const nextPoint = resolveSunObserverPoint(map);
      if (!nextPoint) return;
      setObserverPoint((prev) => (sameSunObserverPoint(prev, nextPoint) ? prev : nextPoint));
    };

    syncObserverPoint();
    map.on('moveend', syncObserverPoint);
    map.on('style.load', syncObserverPoint);
    return () => {
      map.off('moveend', syncObserverPoint);
      map.off('style.load', syncObserverPoint);
    };
  }, [map, isMapLoaded]);

  useEffect(() => {
    if (!observerPointKey || !observerPoint) return;

    let cancelled = false;
    void lookupTimeZoneForPoint(observerPoint).then((timeZone) => {
      if (cancelled) return;
      setObserverTimeZoneState((prev) => (
        prev?.key === observerPointKey && prev.timeZone === timeZone
          ? prev
          : { key: observerPointKey, timeZone }
      ));
    });

    return () => {
      cancelled = true;
    };
  }, [observerPoint, observerPointKey]);

  useEffect(() => {
    if (!map || !isMapLoaded || !observerPoint || !effectiveObserverTimeZone) return;

    let frameId: number | null = null;

    const applySunPosition = () => {
      frameId = null;
      const { sunriseTime, sunsetTime } = resolveSunTimesForLocalDay(
        optsRef.current.date,
        observerPoint.lat,
        observerPoint.lng,
        effectiveObserverTimeZone,
      );
      setTimes((prev) => (
        prev.sunriseTime === sunriseTime && prev.sunsetTime === sunsetTime
          ? prev
          : { sunriseTime, sunsetTime }
      ));

      const position = getSunPositionForLocalDateTime(
        optsRef.current.date,
        optsRef.current.time,
        observerPoint.lat,
        observerPoint.lng,
        effectiveObserverTimeZone,
      );
      if (!position) return;

      setSunPos((prev) => (
        Math.abs(prev.azimuthDeg - position.azimuth) < 0.01
          && Math.abs(prev.altitudeDeg - position.altitude) < 0.01
          ? prev
          : { azimuthDeg: position.azimuth, altitudeDeg: position.altitude }
      ));

      if (!optsRef.current.enabled) return;

      if (optsRef.current.trajectoryEnabled) {
        updateSunRayPosition(
          position.azimuth,
          position.altitude,
          observerPoint.lng,
          observerPoint.lat,
          observerPoint.elevation,
        );
      }

      try {
        map.setLights(buildLights(position.azimuth, position.altitude, optsRef.current.shadowEnabled));
      } catch (err) {
        console.warn('[sunlight] setLights failed', err);
      }

      try {
        map.setFog(FOG_CONFIG as FogSpecification);
      } catch (err) {
        console.warn('[sunlight] setFog failed', err);
      }
    };

    frameId = requestAnimationFrame(applySunPosition);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [
    map,
    isMapLoaded,
    observerPoint,
    effectiveObserverTimeZone,
    opts.enabled,
    opts.date,
    opts.time,
    opts.shadowEnabled,
  ]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const syncSunRayLayer = () => {
      if (!optsRef.current.enabled) {
        removeSunRayLayer(map);
        return;
      }
      if (!optsRef.current.trajectoryEnabled) {
        removeSunRayLayer(map);
        return;
      }
      if (!observerPoint) {
        return;
      }
      try {
        addSunRayLayer(map);
        updateSunRayPosition(
          sunPos.azimuthDeg,
          sunPos.altitudeDeg,
          observerPoint.lng,
          observerPoint.lat,
          observerPoint.elevation,
        );
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
  }, [
    map,
    isMapLoaded,
    observerPoint,
    opts.enabled,
    opts.trajectoryEnabled,
    sunPos.azimuthDeg,
    sunPos.altitudeDeg,
  ]);

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

  return {
    ...times,
    sunAzimuthDeg: sunPos.azimuthDeg,
    sunAltitudeDeg: sunPos.altitudeDeg,
    observerLat: observerPoint?.lat ?? null,
    observerLon: observerPoint?.lng ?? null,
    observerTimeZone,
  };
}
