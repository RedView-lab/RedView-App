import { useEffect, useRef } from 'react';
import type { ErrorEvent as MapboxErrorEvent, Map as MapboxMap, MapSourceDataEvent } from 'mapbox-gl';

import { ALTITUDE_SOURCE_ID } from '../lib/altitude-source';
import {
  createOverlayStatus,
  type OverlayStatusReporter,
} from '@/features/map3d';
import { translateAppText } from '@/shared/i18n';

const SETTLE_MS = 120;
const STAGNATION_MS = 8000;

function tileKeyOf(event: MapSourceDataEvent): string | null {
  const tileID = (event as unknown as {
    tile?: { tileID?: { canonical?: { z: number; x: number; y: number } } };
  }).tile?.tileID?.canonical;
  if (!tileID) return null;
  return `${tileID.z}/${tileID.x}/${tileID.y}`;
}

/**
 * Pastille « Altitude X/Y » de la barre d'état des surcouches. Calquée sur
 * celle de la pente : ne compte que les tuiles de la source d'altitude, publie
 * au plus toutes les 120 ms, et un garde-fou de stagnation force la fin après
 * 8 s pour qu'une tuile retardataire ne bloque jamais la pastille sur
 * « chargement ».
 *
 * `resetKey` remet le décompte à zéro quand la source raster est remplacée
 * (qualité 3D / profil DEM / changement de zone), pour que des clés de tuiles
 * périmées ne comptent jamais.
 */
export function useAltitudeLoadStatus(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  resetKey: string,
  onLoadStatusChange?: OverlayStatusReporter,
): void {
  const reporterRef = useRef(onLoadStatusChange);
  useEffect(() => {
    reporterRef.current = onLoadStatusChange;
  }, [onLoadStatusChange]);

  useEffect(() => {
    if (!map || !isMapLoaded || !reporterRef.current) return;
    if (!enabled) {
      reporterRef.current(null);
      return;
    }

    const requested = new Set<string>();
    const loaded = new Set<string>();
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let lastEmittedProgress = -1;
    let lastEmittedState: 'loading' | 'ready' = 'loading';
    let lastProgressMs = Date.now();

    const emit = (state: 'loading' | 'ready', progress: number, detail?: string) => {
      if (state === lastEmittedState && progress === lastEmittedProgress) return;
      lastEmittedState = state;
      lastEmittedProgress = progress;
      reporterRef.current?.(createOverlayStatus({
        id: 'altitude',
        label: 'Altitude',
        state,
        progress,
        detail,
      }));
    };

    const isSourceLoaded = (): boolean => {
      try {
        return Boolean(map.getSource(ALTITUDE_SOURCE_ID)) && map.isSourceLoaded(ALTITUDE_SOURCE_ID);
      } catch {
        return false;
      }
    };

    const publishProgress = () => {
      const total = requested.size;
      const done = loaded.size;
      if (total === 0) {
        // Chaque tuile visible venait du cache (pas d'événement
        // sourcedataloading) : rien n'est en vol, la surcouche est prête.
        if (isSourceLoaded()) {
          emit('ready', 100, 'Altitude prête');
          return;
        }
        emit('loading', 5, 'En attente de tuiles');
        return;
      }
      if (done >= total) {
        emit('ready', 100, 'Altitude prête');
        return;
      }
      const pct = Math.max(1, Math.min(99, Math.round((done / total) * 100)));
      emit('loading', pct, translateAppText('Tuiles {{done}}/{{total}}', { done, total }));
    };

    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        watchdog = null;
        if (requested.size === 0) {
          // Rien en vol (ou toutes les tuiles en erreur) pendant toute une
          // fenêtre de stagnation : la surcouche est aussi chargée qu'elle le sera.
          if (Date.now() - lastProgressMs >= STAGNATION_MS) {
            emit('ready', 100, 'Altitude prête');
            return;
          }
          publishProgress();
          armWatchdog();
          return;
        }
        if (loaded.size >= requested.size) {
          emit('ready', 100, 'Altitude prête');
          return;
        }
        if (Date.now() - lastProgressMs >= STAGNATION_MS) {
          emit('ready', 100, translateAppText('Altitude prête ({{count}} en attente)', { count: requested.size - loaded.size }));
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
      }, SETTLE_MS);
    };

    const onLoading = (event: MapSourceDataEvent) => {
      if (event.sourceId !== ALTITUDE_SOURCE_ID) return;
      const key = tileKeyOf(event);
      if (!key) return;
      if (!requested.has(key)) {
        requested.add(key);
        lastProgressMs = Date.now();
      }
      scheduleSettle();
      armWatchdog();
    };

    const onLoaded = (event: MapSourceDataEvent) => {
      if (event.sourceId !== ALTITUDE_SOURCE_ID) return;
      const key = tileKeyOf(event);
      if (key) {
        requested.add(key);
        if (!loaded.has(key)) {
          loaded.add(key);
          lastProgressMs = Date.now();
        }
      }
      armWatchdog();
      scheduleSettle();
    };

    const onAbort = (event: MapSourceDataEvent) => {
      if (event.sourceId !== ALTITUDE_SOURCE_ID) return;
      const key = tileKeyOf(event);
      if (key) {
        requested.delete(key);
        loaded.delete(key);
        lastProgressMs = Date.now();
      }
      armWatchdog();
      scheduleSettle();
    };

    // Les tuiles en échec (404 / réseau) émettent `error`, pas `sourcedata` :
    // sans cela, elles restaient « demandées » et bloquaient la pastille sous 100 %.
    const onTileError = (event: MapboxErrorEvent) => {
      onAbort(event as unknown as MapSourceDataEvent);
    };

    map.on('sourcedataloading', onLoading);
    map.on('sourcedata', onLoaded);
    map.on('dataabort', onAbort);
    map.on('error', onTileError);

    emit('loading', 5, 'Préparation altitude');
    armWatchdog();

    return () => {
      map.off('sourcedataloading', onLoading);
      map.off('sourcedata', onLoaded);
      map.off('dataabort', onAbort);
      map.off('error', onTileError);
      if (settleTimer) clearTimeout(settleTimer);
      if (watchdog) clearTimeout(watchdog);
      reporterRef.current?.(null);
    };
  }, [map, isMapLoaded, enabled, resetKey]);
}
