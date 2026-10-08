import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

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
import { setSunLightOverride } from '@/features/map3d/lib/mapEnvironment';
import { resolveTimeZoneAt } from '@/shared/lib/timeZoneAt';

/**
 * Calcule la position réelle du soleil à partir de la date / heure et du centre
 * de la carte.
 *
 * Volontairement, on NE module PLUS la luminosité de toute la scène. L'ancien
 * cycle brouillard / lightPreset éclaircissait et assombrissait tant l'écran
 * que les ombres du relief devenaient difficiles à lire. Le système
 * d'ensoleillement garde désormais un éclairage de scène visuellement neutre et
 * n'utilise la position du soleil que pour la direction des ombres et les
 * heures de lever / coucher affichées. Les lumières et le brouillard de la scène
 * appartiennent à `map3d/lib/mapEnvironment` (jour / crépuscule / nuit) : ce
 * hook publie seulement la vraie direction du soleil comme forçage.
 */
export interface UseSunlightOptions {
  enabled: boolean;
  /** ISO YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
  trajectoryEnabled: boolean;
  /**
   * Ombres portées GPU en temps réel sur la géométrie 3D (`cast-shadows` de
   * Mapbox). C'est le chemin coûteux : sur les styles avec bâtiments extrudés
   * (p. ex. le fond clair « Standard »), il impose à chaque image une passe de
   * shadow map sur chaque bâtiment extrudé et effondre les FPS en ville. Lié au
   * même interrupteur « Ombres » que la surcouche DEM par lancer de rayons, pour
   * que l'utilisateur n'ait qu'un seul réglage.
   */
  shadowEnabled: boolean;
}

export interface UseSunlightResult {
  sunriseTime: string;
  sunsetTime: string;
  /** Azimut actuel du soleil en degrés (0 = N, sens horaire). Mis à jour à chaque application. */
  sunAzimuthDeg: number;
  /** Altitude actuelle du soleil en degrés (-90..+90). Mise à jour à chaque application. */
  sunAltitudeDeg: number;
  observerLat: number | null;
  observerLon: number | null;
  observerTimeZone: string | null;
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
  // Classes de ~100 m : bien assez pour les limites de fuseau, cache borné pendant les déplacements.
  const key = `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
  const existing = timeZoneLookupCache.get(key);
  if (existing) return existing;

  const resolved = resolveTimeZoneAt(point.lng, point.lat);
  timeZoneLookupCache.set(key, resolved);
  void resolved.then((timeZone) => {
    // Un chargement de table raté ne doit pas rester collé : la recherche suivante réessaie.
    if (!timeZone) timeZoneLookupCache.delete(key);
  });
  return resolved;
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

  // Réfs stables pour que l'écouteur moveend voie toujours les dernières valeurs
  // sans se réabonner à chaque rendu.
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
    void lookupTimeZoneForPoint(observerPoint).then((resolvedTimeZone) => {
      if (cancelled) return;
      // Table indisponible : le fuseau du navigateur garde les surcouches utilisables.
      const timeZone = resolvedTimeZone ?? getHostTimeZone();
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

      setSunLightOverride({
        azimuthDeg: position.azimuth,
        altitudeDeg: position.altitude,
        castShadows: optsRef.current.shadowEnabled,
      });
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

  // Retour à la direction de lumière par défaut de l'environnement quand le panneau est désactivé.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (opts.enabled) return;
    removeSunRayLayer(map);
    setSunLightOverride(null);
  }, [map, isMapLoaded, opts.enabled]);

  useEffect(() => () => setSunLightOverride(null), []);

  return {
    ...times,
    sunAzimuthDeg: sunPos.azimuthDeg,
    sunAltitudeDeg: sunPos.altitudeDeg,
    observerLat: observerPoint?.lat ?? null,
    observerLon: observerPoint?.lng ?? null,
    observerTimeZone,
  };
}
