import { useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap, MapSourceDataEvent } from 'mapbox-gl';
import type { AltitudeCategory, AltitudeColorMode } from '../types';
import {
  ALTITUDE_LAYER_ID,
  ALTITUDE_SOURCE_ID,
  buildAltitudeColorExpression,
  buildAltitudeLayer,
  buildAltitudeTileSource,
} from '../lib/altitude-source';
import {
  createOverlayStatus,
  type OverlayStatusReporter,
} from '@/features/map3d';

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clearAltitudeCache = () => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_ALTITUDE_CACHE' });
    console.log('[altitude][debug] CLEAR_ALTITUDE_CACHE sent — reload to fetch fresh tiles.');
  };
}

function addAltitudeLayer(
  map: MapboxMap,
  opacity: number,
  colorMode: AltitudeColorMode,
  categories: AltitudeCategory[],
  hiddenIds: Set<string>,
) {
  try {
    if (!map.getSource(ALTITUDE_SOURCE_ID)) {
      map.addSource(ALTITUDE_SOURCE_ID, buildAltitudeTileSource());
    }
    if (!map.getLayer(ALTITUDE_LAYER_ID)) {
      const layer = buildAltitudeLayer(opacity, colorMode, categories, hiddenIds);
      map.addLayer(layer as Parameters<MapboxMap['addLayer']>[0]);
    }
  } catch {
    /* style may be transitioning */
  }
}

function removeAltitudeLayer(map: MapboxMap) {
  try {
    if (map.getLayer(ALTITUDE_LAYER_ID)) map.removeLayer(ALTITUDE_LAYER_ID);
    if (map.getSource(ALTITUDE_SOURCE_ID)) map.removeSource(ALTITUDE_SOURCE_ID);
  } catch {
    /* style may be transitioning */
  }
}

function setAltitudeVisibility(map: MapboxMap, visible: boolean) {
  try {
    if (map.getLayer(ALTITUDE_LAYER_ID)) {
      map.setLayoutProperty(ALTITUDE_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
    }
  } catch {
    /* layer may not exist yet */
  }
}

export function useAltitude(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  colorMode: AltitudeColorMode,
  categories: AltitudeCategory[],
  hiddenBandIds?: ReadonlyArray<string>,
  onLoadStatusChange?: OverlayStatusReporter,
) {
  const hiddenIds = useMemo(() => new Set(hiddenBandIds ?? []), [hiddenBandIds]);
  const categoriesKey = useMemo(
    () => categories.map((cat) => `${cat.id}:${cat.minMeters}-${cat.maxMeters}:${cat.color}`).join('|'),
    [categories],
  );
  const hiddenKey = useMemo(() => Array.from(hiddenIds).sort().join(','), [hiddenIds]);

  const opacityRef = useRef(opacity);
  const colorModeRef = useRef(colorMode);
  const enabledRef = useRef(enabled);
  const categoriesRef = useRef(categories);
  const hiddenIdsRef = useRef(hiddenIds);
  opacityRef.current = opacity;
  colorModeRef.current = colorMode;
  enabledRef.current = enabled;
  categoriesRef.current = categories;
  hiddenIdsRef.current = hiddenIds;

  const mountedRef = useRef(false);

  useEffect(() => {
    if (!map || !isMapLoaded || !enabled) return;
    if (mountedRef.current) return;
    addAltitudeLayer(
      map,
      opacityRef.current,
      colorModeRef.current,
      categoriesRef.current,
      hiddenIdsRef.current,
    );
    mountedRef.current = true;
  }, [map, isMapLoaded, enabled]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    setAltitudeVisibility(map, enabled);
  }, [map, isMapLoaded, enabled]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    try {
      if (map.getLayer(ALTITUDE_LAYER_ID)) {
        map.setPaintProperty(ALTITUDE_LAYER_ID, 'raster-opacity', opacity);
      }
    } catch {
      /* layer may not exist yet */
    }
  }, [map, isMapLoaded, opacity]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current || !categories.length) return;
    try {
      if (map.getLayer(ALTITUDE_LAYER_ID)) {
        const expr = buildAltitudeColorExpression(categories, colorMode, hiddenIds);
        map.setPaintProperty(ALTITUDE_LAYER_ID, 'raster-color', expr as unknown as string);
      }
    } catch {
      /* layer may not exist yet */
    }
  }, [map, isMapLoaded, colorMode, categoriesKey, hiddenKey]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (!enabledRef.current) return;
        addAltitudeLayer(
          map,
          opacityRef.current,
          colorModeRef.current,
          categoriesRef.current,
          hiddenIdsRef.current,
        );
        mountedRef.current = true;
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => {
      map.off('style.load', onStyleLoad);
    };
  }, [map, isMapLoaded]);

  useEffect(() => {
    if (!map) return;
    return () => {
      try {
        if (map.getStyle && map.getStyle()) removeAltitudeLayer(map);
      } catch {
        /* map already destroyed */
      }
      mountedRef.current = false;
    };
  }, [map]);

  // ── Tile load progress reporter ───────────────────────────────────────
  // Mirrors the slope reporter (see useSlope.ts) — without it the user
  // toggles altitude on and sees absolutely nothing happen for the
  // several seconds the SW pipeline takes to decode DEM tiles into
  // Terrarium-style PNGs across the visible viewport. The pill provides
  // immediate "Altitude X/Y" feedback and a stagnation watchdog that
  // force-completes after 8 s so we never strand the user mid-load.
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

    const isAltitudeEvent = (event: MapSourceDataEvent): boolean => (
      event.sourceId === ALTITUDE_SOURCE_ID
    );

    const emit = (state: 'loading' | 'ready', progress: number, detail?: string) => {
      if (state === lastEmittedState && progress === lastEmittedProgress) return;
      lastEmittedState = state;
      lastEmittedProgress = progress;
      onLoadStatusChangeRef.current?.(createOverlayStatus({
        id: 'altitude',
        label: 'Altitude',
        state,
        progress,
        detail,
      }));
    };

    const publishProgress = () => {
      const total = requested.size;
      const done = loaded.size;
      if (total === 0) {
        emit('loading', 5, 'En attente de tuiles');
        return;
      }
      if (done >= total) {
        emit('ready', 100, 'Altitude prête');
        return;
      }
      const ratio = done / Math.max(total, 1);
      const pct = Math.max(1, Math.min(99, Math.round(ratio * 100)));
      emit('loading', pct, `Tuiles ${done}/${total}`);
    };

    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      const STAGNATION_MS = 8000;
      watchdog = setTimeout(() => {
        watchdog = null;
        if (requested.size === 0) return;
        if (loaded.size >= requested.size) {
          emit('ready', 100, 'Altitude prête');
          return;
        }
        const sinceProgress = Date.now() - lastProgressMs;
        if (sinceProgress >= STAGNATION_MS) {
          const stragglers = requested.size - loaded.size;
          emit('ready', 100, `Altitude prête (${stragglers} en attente)`);
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
      if (!isAltitudeEvent(event)) return;
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
      if (!isAltitudeEvent(event)) return;
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
      if (!isAltitudeEvent(event)) return;
      const key = tileKey(event);
      if (key) {
        requested.delete(key);
        loaded.delete(key);
        lastProgressMs = Date.now();
      }
      armWatchdog();
      scheduleSettle();
    };

    map.on('sourcedataloading', onLoading);
    map.on('sourcedata', onLoaded);
    map.on('dataabort', onError);

    emit('loading', 5, 'Préparation altitude');
    armWatchdog();

    return () => {
      map.off('sourcedataloading', onLoading);
      map.off('sourcedata', onLoaded);
      map.off('dataabort', onError);
      if (settleTimer) clearTimeout(settleTimer);
      if (watchdog) clearTimeout(watchdog);
      onLoadStatusChangeRef.current?.(null);
    };
  }, [map, isMapLoaded, enabled]);
}