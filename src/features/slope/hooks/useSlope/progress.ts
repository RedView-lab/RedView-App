import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ErrorEvent as MapboxErrorEvent, Map as MapboxMap, MapSourceDataEvent } from 'mapbox-gl';
import { createOverlayStatus, type OverlayStatusReporter } from '@/features/map3d';
import { SLOPE_SOURCE_ID } from '../../lib/slope-source';
import { canStartSlopeWork } from './helpers';

interface UseSlopeProgressReporterOptions {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  enabled: boolean;
  onLoadStatusChange?: OverlayStatusReporter;
  mountedRef: MutableRefObject<boolean>;
}

export function useSlopeProgressReporter({
  map,
  isMapLoaded,
  enabled,
  onLoadStatusChange,
  mountedRef,
}: UseSlopeProgressReporterOptions): void {
  const onLoadStatusChangeRef = useRef(onLoadStatusChange);
  useEffect(() => {
    onLoadStatusChangeRef.current = onLoadStatusChange;
  }, [onLoadStatusChange]);

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
    let isZonePipelineActive = false;
    let lastZoneProgressMs = 0;

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
      // If zone pipeline is driving progress, NEVER let viewport/idle emit ready
      if (isZonePipelineActive) {
        return;
      }
      const total = requested.size;
      const done = loaded.size;
      if (total === 0) {
        if (!canStartSlopeWork(map)) {
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

    const STAGNATION_MS = 8000;
    const HARD_STAGNATION_MS = 16000;
    const ZONE_SILENCE_MS = 15000;
    const READY_STRAGGLER_THRESHOLD = 8;

    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        watchdog = null;
        if (isZonePipelineActive) {
          const sinceZone = Date.now() - lastZoneProgressMs;
          if (sinceZone < ZONE_SILENCE_MS) {
            armWatchdog();
            return;
          }
          // Failsafe: the SW zone pipeline went silent (killed SW, dropped
          // message…) — stop waiting for its "done" phase.
          isZonePipelineActive = false;
        }
        if (requested.size === 0) {
          // Nothing in flight for a full stagnation window: done.
          if (Date.now() - lastProgressMs >= STAGNATION_MS) {
            emit('ready', 100, 'Pentes prêtes');
            return;
          }
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
      if (isZonePipelineActive) return;
      if (requested.size !== 0) return;
      publishProgress();
      armWatchdog();
    };

    const onViewportChange = () => {
      // Don't reset if active zone pipeline is running
      if (isZonePipelineActive) {
        return;
      }
      requested.clear();
      loaded.clear();
      lastProgressMs = Date.now();
      scheduleSettle();
      armWatchdog();
    };

    // ── SW Zone Progress Listener ──────────────────────────────────────
    const onSwMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'ZONE_SLOPE_PROGRESS') return;
      const { phase, loaded: count, total: totalCount, percent } = event.data;
      isZonePipelineActive = phase !== 'done';
      lastZoneProgressMs = Date.now();
      lastProgressMs = Date.now();

      if (phase === 'low') {
        const p = typeof percent === 'number' && percent > 0 ? percent : Math.max(5, Math.min(50, Math.round(((count || 0) / (totalCount || 1)) * 50)));
        emit('loading', p, `Pentes 30m (${count}/${totalCount})`);
      } else if (phase === 'hd') {
        const p = typeof percent === 'number' && percent > 0 ? percent : Math.max(50, Math.min(99, 50 + Math.round(((count || 0) / (totalCount || 1)) * 49)));
        emit('loading', p, `LiDAR HD (${count}/${totalCount})`);
      } else if (phase === 'done') {
        isZonePipelineActive = false;
        emit('ready', 100, 'Pentes HD prêtes');
      }
    };

    // Failed tiles emit `error`, not `sourcedata`/`dataabort`.
    const onTileError = (event: MapboxErrorEvent) => {
      onError(event as unknown as MapSourceDataEvent);
    };

    map.on('sourcedataloading', onLoading);
    map.on('sourcedata', onLoaded);
    map.on('dataabort', onError);
    map.on('error', onTileError);
    map.on('idle', onIdle);
    map.on('movestart', onViewportChange);
    map.on('zoomstart', onViewportChange);
    navigator.serviceWorker?.addEventListener('message', onSwMessage);

    emit('loading', 5, 'Préparation des pentes');
    armWatchdog();

    return () => {
      map.off('sourcedataloading', onLoading);
      map.off('sourcedata', onLoaded);
      map.off('dataabort', onError);
      map.off('error', onTileError);
      map.off('idle', onIdle);
      map.off('movestart', onViewportChange);
      map.off('zoomstart', onViewportChange);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
      if (settleTimer) clearTimeout(settleTimer);
      if (watchdog) clearTimeout(watchdog);
      onLoadStatusChangeRef.current?.(null);
    };
  }, [map, isMapLoaded, enabled, mountedRef]);
}