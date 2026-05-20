import { useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { SlopeCategory, SlopeColorMode } from '../../types';
import { type SlopeTileSourceOptions, buildSlopeColorExpression, buildSlopeSourceKey } from '../../lib/slope-source';
import {
  addSlopeLayer,
  cancelSlopeWorkerPressure,
  canStartSlopeWork,
  hiddenIdsFromRanges,
  removeSlopeLayer,
  setSlopeVisibility,
} from './helpers';
import { useSlopeProgressReporter } from './progress';

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clearSlopeCache = () => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_SLOPE_CACHE' });
    console.log('[slope][debug] CLEAR_SLOPE_CACHE sent — reload to fetch fresh tiles.');
  };
}

export function useSlope(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  colorMode: SlopeColorMode,
  hiddenRanges?: ReadonlyArray<readonly [number, number]>,
  categories?: SlopeCategory[],
  sourceOptions: SlopeTileSourceOptions = { demProfile: 'default', resolutionFactor: 1 },
  onLoadStatusChange?: Parameters<typeof useSlopeProgressReporter>[0]['onLoadStatusChange'],
) {
  const hiddenIds = useMemo(
    () => hiddenIdsFromRanges(hiddenRanges, categories),
    [hiddenRanges, categories],
  );

  const categoriesKey = useMemo(
    () => (categories ?? []).map((category) => `${category.id}:${category.minDeg}-${category.maxDeg}:${category.color}`).join('|'),
    [categories],
  );

  const hiddenKey = useMemo(
    () => Array.from(hiddenIds).sort().join(','),
    [hiddenIds],
  );
  const sourceKey = useMemo(() => buildSlopeSourceKey(sourceOptions), [sourceOptions]);

  const opacityRef = useRef(opacity);
  const colorModeRef = useRef(colorMode);
  const enabledRef = useRef(enabled);
  const previousEnabledRef = useRef(enabled);
  const categoriesRef = useRef(categories);
  const hiddenIdsRef = useRef(hiddenIds);
  const sourceOptionsRef = useRef(sourceOptions);
  opacityRef.current = opacity;
  colorModeRef.current = colorMode;
  enabledRef.current = enabled;
  categoriesRef.current = categories;
  hiddenIdsRef.current = hiddenIds;
  sourceOptionsRef.current = sourceOptions;

  const mountedRef = useRef(false);
  const visibilityDeferredRef = useRef(enabled);
  const mountedSourceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!map || !isMapLoaded || !enabled) return;
    if (mountedRef.current) return;
    const mounted = addSlopeLayer(
      map,
      opacityRef.current,
      colorModeRef.current,
      categoriesRef.current ?? [],
      hiddenIdsRef.current,
      sourceOptionsRef.current,
    );
    if (!mounted) return;
    mountedRef.current = true;
    mountedSourceKeyRef.current = buildSlopeSourceKey(sourceOptionsRef.current);
    setSlopeVisibility(map, enabledRef.current && !visibilityDeferredRef.current);
  }, [map, isMapLoaded, enabled, sourceKey]);

  useEffect(() => {
    if (!map || !isMapLoaded || !enabled || mountedRef.current) return;

    const tryMount = () => {
      if (mountedRef.current || !enabledRef.current) return;
      if (!canStartSlopeWork(map)) return;
      const mounted = addSlopeLayer(
        map,
        opacityRef.current,
        colorModeRef.current,
        categoriesRef.current ?? [],
        hiddenIdsRef.current,
        sourceOptionsRef.current,
      );
      if (!mounted) return;
      mountedRef.current = true;
      mountedSourceKeyRef.current = buildSlopeSourceKey(sourceOptionsRef.current);
      setSlopeVisibility(map, enabledRef.current && !visibilityDeferredRef.current);
      map.triggerRepaint();
    };

    tryMount();
    map.on('styledata', tryMount);
    map.on('sourcedata', tryMount);
    map.on('idle', tryMount);
    return () => {
      map.off('styledata', tryMount);
      map.off('sourcedata', tryMount);
      map.off('idle', tryMount);
    };
  }, [map, isMapLoaded, enabled]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    if (mountedSourceKeyRef.current === sourceKey) return;
    removeSlopeLayer(map);
    mountedRef.current = false;
    visibilityDeferredRef.current = enabledRef.current;
    const mounted = addSlopeLayer(
      map,
      opacityRef.current,
      colorModeRef.current,
      categoriesRef.current ?? [],
      hiddenIdsRef.current,
      sourceOptions,
    );
    if (!mounted) return;
    mountedRef.current = true;
    mountedSourceKeyRef.current = sourceKey;
    setSlopeVisibility(map, enabledRef.current && !visibilityDeferredRef.current);
  }, [map, isMapLoaded, sourceKey, sourceOptions]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    setSlopeVisibility(map, enabled && !visibilityDeferredRef.current);
  }, [map, isMapLoaded, enabled]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (!enabled) {
      visibilityDeferredRef.current = false;
      if (mountedRef.current) setSlopeVisibility(map, false);
      return;
    }

    visibilityDeferredRef.current = true;
    if (mountedRef.current) setSlopeVisibility(map, false);

    const resumeSlope = () => {
      if (!enabledRef.current) return;
      if (map.isMoving()) return;
      if (!canStartSlopeWork(map)) return;
      visibilityDeferredRef.current = false;
      if (mountedRef.current) {
        setSlopeVisibility(map, true);
        map.triggerRepaint();
      }
    };

    const cancelTerrainSlopeBacklog = () => {
      if (!enabledRef.current) return;
      if (sourceOptionsRef.current.demProfile !== 'terrain') return;
      cancelSlopeWorkerPressure();
    };

    map.on('movestart', cancelTerrainSlopeBacklog);
    map.on('zoomstart', cancelTerrainSlopeBacklog);
    map.on('moveend', resumeSlope);
    map.on('zoomend', resumeSlope);
    map.on('sourcedata', resumeSlope);
    map.on('styledata', resumeSlope);
    map.on('idle', resumeSlope);
    return () => {
      map.off('movestart', cancelTerrainSlopeBacklog);
      map.off('zoomstart', cancelTerrainSlopeBacklog);
      map.off('moveend', resumeSlope);
      map.off('zoomend', resumeSlope);
      map.off('sourcedata', resumeSlope);
      map.off('styledata', resumeSlope);
      map.off('idle', resumeSlope);
    };
  }, [map, isMapLoaded, enabled]);

  useEffect(() => {
    const wasEnabled = previousEnabledRef.current;
    previousEnabledRef.current = enabled;
    if (!map || !isMapLoaded) return;
    if (enabled || !wasEnabled) return;

    visibilityDeferredRef.current = false;
    cancelSlopeWorkerPressure();

    // Full teardown on disable for BOTH demProfiles (default 0.40 m and
    // terrain 1 m). Leaving the raster source attached with
    // `visibility:'none'` keeps Mapbox's internal SourceCache registered,
    // which keeps emitting `styledata` on every style update and prevents
    // `idle` from firing cleanly — that idle gate is what drives the
    // ambient DEM/ortho prefetch (viewportPrefetch.ts) AND the basemap
    // refresh hooks. Result: after disable, no further DEM/ortho tiles
    // load until the user reloads the page. Matches the May 19 pattern
    // already applied to useWeatherOverlay / useWindTerrainOverlay (see
    // overlay-disable-teardown-and-terrain-renderable-may19.md), and the
    // May 8 pattern that already removed the source for the terrain
    // profile only (slope-1m-disable-cancel-may08.md). `removeSlopeLayer`
    // snapshots and re-applies the current terrain so a managed terrain
    // setup is never lost across the source removal.
    if (mountedRef.current) {
      removeSlopeLayer(map);
      mountedRef.current = false;
      mountedSourceKeyRef.current = null;
      try { map.triggerRepaint(); } catch { /* map gone */ }
    }
  }, [map, isMapLoaded, enabled]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    try {
      if (map.getLayer('slope-overlay')) {
        map.setPaintProperty('slope-overlay', 'raster-opacity', opacity);
      }
    } catch {
      /* layer may not exist yet */
    }
  }, [map, isMapLoaded, opacity]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    if (!categories?.length) return;
    try {
      if (map.getLayer('slope-overlay')) {
        const expression = buildSlopeColorExpression(categories, colorMode, hiddenIds);
        map.setPaintProperty(
          'slope-overlay',
          'raster-color',
          expression as unknown as string,
        );
      }
    } catch {
      /* layer may not exist yet */
    }
  }, [map, isMapLoaded, colorMode, categoriesKey, hiddenKey]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      mountedRef.current = false;
      mountedSourceKeyRef.current = null;
      setTimeout(() => {
        if (!enabledRef.current) return;
        visibilityDeferredRef.current = true;
        const mounted = addSlopeLayer(
          map,
          opacityRef.current,
          colorModeRef.current,
          categoriesRef.current ?? [],
          hiddenIdsRef.current,
          sourceOptionsRef.current,
        );
        if (!mounted) return;
        mountedRef.current = true;
        mountedSourceKeyRef.current = buildSlopeSourceKey(sourceOptionsRef.current);
        setSlopeVisibility(map, enabledRef.current && !visibilityDeferredRef.current);
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
        if (map.getStyle && map.getStyle()) removeSlopeLayer(map);
      } catch {
        /* map already destroyed */
      }
      mountedRef.current = false;
    };
  }, [map]);

  useSlopeProgressReporter({
    map,
    isMapLoaded,
    enabled,
    onLoadStatusChange,
    visibilityDeferredRef,
    mountedRef,
  });
}