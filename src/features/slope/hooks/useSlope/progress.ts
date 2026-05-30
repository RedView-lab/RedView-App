import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Map as MapboxMap, MapSourceDataEvent } from 'mapbox-gl';
import { createOverlayStatus, type OverlayStatusReporter } from '@/features/map3d';
import { SLOPE_SOURCE_ID } from '../../lib/slope-source';
import { canStartSlopeWork } from './helpers';

interface UseSlopeProgressReporterOptions {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  enabled: boolean;
  onLoadStatusChange?: OverlayStatusReporter;
  visibilityDeferredRef: MutableRefObject<boolean>;
  mountedRef: MutableRefObject<boolean>;
}

export function useSlopeProgressReporter({
  map,
  isMapLoaded,
  enabled,
  onLoadStatusChange,
  visibilityDeferredRef,
  mountedRef,
}: UseSlopeProgressReporterOptions): void {
  const onLoadStatusChangeRef = useRef(onLoadStatusChange);
  onLoadStatusChangeRef.current = onLoadStatusChange;

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const reporter = onLoadStatusChangeRef.current;
    if (!reporter) return;
    if (!enabled) {
      reporter(null);
      return;
    }

    const requested = new Set<string>();
    const loaded = new Set<string>();
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let lastEmittedProgress = -1;
    let lastEmittedState: 'loading' | 'ready' = 'loading';
    let lastProgressMs = Date.now();

    const tileKey = (event: MapSourceDataEvent): string | null => {
      const tileID = (event as unknown as {
        tile?: { tileID?: { canonical?: { z: number; x: number; y: number } } };
      }).tile?.tileID?.canonical;
      if (!tileID) return null;
      return `${tileID.z}/${tileID.x}/${tileID.y}`;
    };

    const isSlopeEvent = (event: MapSourceDataEvent): boolean => event.sourceId === SLOPE_SOURCE_ID;

    const emit = (state: 'loading' | 'ready', progress: number, detail?: string) => {
      if (state === lastEmittedState && progress === lastEmittedProgress) return;
      lastEmittedState = state;
      lastEmittedProgress = progress;
      onLoadStatusChangeRef.current?.(createOverlayStatus({
        id: 'slope',
        label: 'Pentes',
        state,
        progress,
        detail,
      }));
    };

    const publishProgress = () => {
      const total = requested.size;
      const done = loaded.size;
      if (total === 0) {
        if (visibilityDeferredRef.current || !canStartSlopeWork(map)) {
          emit('loading', 5, 'En attente du relief');
          return;
        }
        let sourceLoaded = false;
        try {
          sourceLoaded = map.isSourceLoaded(SLOPE_SOURCE_ID);
        } catch {
          sourceLoaded = false;
        }
        if (mountedRef.current && sourceLoaded) {
          emit('ready', 100, 'Pentes prêtes');
          return;
        }
        emit('loading', 5, 'En attente de tuiles');
        return;
      }
      if (done >= total) {
        emit('ready', 100, 'Pentes prêtes');
        return;
      }
      const ratio = done / Math.max(total, 1);
      const pct = Math.max(1, Math.min(99, Math.round(ratio * 100)));
      emit('loading', pct, `Tuiles ${done}/${total}`);
    };

    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      const STAGNATION_MS = 8000;
      const HARD_STAGNATION_MS = 35000;
      const READY_STRAGGLER_THRESHOLD = 8;
      watchdog = setTimeout(() => {
        watchdog = null;
        if (requested.size === 0) {
          publishProgress();
          armWatchdog();
          return;
        }
        if (loaded.size >= requested.size) {
          emit('ready', 100, 'Pentes prêtes');
          return;
        }
        const sinceProgress = Date.now() - lastProgressMs;
        if (sinceProgress >= STAGNATION_MS) {
          const stragglers = requested.size - loaded.size;
          if (stragglers <= READY_STRAGGLER_THRESHOLD || sinceProgress >= HARD_STAGNATION_MS) {
            emit('ready', 100, `Pentes prêtes (${stragglers} en attente)`);
            return;
          }
          const total = requested.size;
          const done = loaded.size;
          const pct = Math.max(1, Math.min(99, Math.round((done / Math.max(total, 1)) * 100)));
          emit('loading', pct, `Tuiles ${done}/${total} (${stragglers} en traitement)`);
          armWatchdog();
          return;
        }
        armWatchdog();
      }, STAGNATION_MS);
    };

    const scheduleSettle = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        publishProgress();
      }, 120);
    };

    const onLoading = (event: MapSourceDataEvent) => {
      if (!isSlopeEvent(event)) return;
      const key = tileKey(event);
      if (!key) return;
      if (!requested.has(key)) {
        requested.add(key);
        lastProgressMs = Date.now();
      }
      scheduleSettle();
      armWatchdog();
    };

    const onLoaded = (event: MapSourceDataEvent) => {
      if (!isSlopeEvent(event)) return;
      const key = tileKey(event);
      if (key) {
        if (!requested.has(key)) {
          requested.add(key);
          lastProgressMs = Date.now();
        }
        if (!loaded.has(key)) {
          loaded.add(key);
          lastProgressMs = Date.now();
        }
      }
      armWatchdog();
      scheduleSettle();
    };

    const onError = (event: MapSourceDataEvent) => {
      if (!isSlopeEvent(event)) return;
      const key = tileKey(event);
      if (key) {
        requested.delete(key);
        loaded.delete(key);
        lastProgressMs = Date.now();
      }
      armWatchdog();
      scheduleSettle();
    };

    const onIdle = () => {
      if (requested.size !== 0) return;
      publishProgress();
      armWatchdog();
    };

    // ── Reset progress tracking on every viewport change ───────────────
    // `requested` / `loaded` accumulate one entry per slope tile that ever
    // fired `sourcedataloading`. Mapbox keeps already-loaded tiles across
    // pans and never re-emits a loading event for them, so these Sets are
    // effectively SESSION-CUMULATIVE: after exploring several areas the
    // denominator balloons (the "Tuiles 43/1809" the user reported) even
    // though only a handful of tiles for the CURRENT viewport are actually
    // outstanding. That stale denominator also feeds the watchdog's
    // straggler math, keeping the pill stuck. Clearing both Sets when the
    // viewport starts moving rescopes the counter to the new viewport's
    // tiles only — already-rendered tiles stay on screen (Mapbox cache),
    // they simply don't need to be re-counted.
    const onViewportChange = () => {
      requested.clear();
      loaded.clear();
      lastProgressMs = Date.now();
      scheduleSettle();
      armWatchdog();
    };

    map.on('sourcedataloading', onLoading);
    map.on('sourcedata', onLoaded);
    map.on('dataabort', onError);
    map.on('idle', onIdle);
    map.on('movestart', onViewportChange);
    map.on('zoomstart', onViewportChange);

    emit('loading', 5, 'Préparation des pentes');
    armWatchdog();

    return () => {
      map.off('sourcedataloading', onLoading);
      map.off('sourcedata', onLoaded);
      map.off('dataabort', onError);
      map.off('idle', onIdle);
      map.off('movestart', onViewportChange);
      map.off('zoomstart', onViewportChange);
      if (settleTimer) clearTimeout(settleTimer);
      if (watchdog) clearTimeout(watchdog);
      onLoadStatusChangeRef.current?.(null);
    };
  }, [map, isMapLoaded, enabled, mountedRef, visibilityDeferredRef]);
}