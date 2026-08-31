import { useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { SlopeCategory, SlopeColorMode, SlopeDemProfile } from '../../types';
import { type SlopeTileSourceOptions, type SlopeZoneOptions, buildSlopeColorExpression, buildSlopeSourceKey } from '../../lib/slope-source';
import {
  addSlopeLayer,
  canStartSlopeWork,
  hiddenIdsFromRanges,
  notifySlopeActiveState,
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
  const lastZonePipelineRef = useRef<{ hash: string; profile: string; time: number } | null>(null);

  const triggerZonePipeline = (zone: SlopeZoneOptions, profile: SlopeDemProfile) => {
    const now = Date.now();
    if (
      lastZonePipelineRef.current &&
      lastZonePipelineRef.current.hash === zone.hash &&
      lastZonePipelineRef.current.profile === profile &&
      now - lastZonePipelineRef.current.time < 1000
    ) {
      return;
    }
    lastZonePipelineRef.current = { hash: zone.hash, profile, time: now };

    try {
      const [w, s, e, n] = zone.bounds;
      const tiles: Array<{ z: number; x: number; y: number }> = [];
      const seen = new Set<string>();
      const z = 14;
      const world = 1 << z;
      const minX = Math.max(0, Math.min(world - 1, Math.floor(((w + 180) / 360) * world)));
      const maxX = Math.max(0, Math.min(world - 1, Math.floor(((e + 180) / 360) * world)));
      const minLatRad = (Math.min(85, Math.max(-85, s)) * Math.PI) / 180;
      const maxLatRad = (Math.min(85, Math.max(-85, n)) * Math.PI) / 180;
      const maxY = Math.max(0, Math.min(world - 1, Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + minLatRad / 2)) / (2 * Math.PI)) * world)));
      const minY = Math.max(0, Math.min(world - 1, Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + maxLatRad / 2)) / (2 * Math.PI)) * world)));

      for (let tx = minX; tx <= maxX; tx++) {
        for (let ty = minY; ty <= maxY; ty++) {
          const key = `${z}/${tx}/${ty}`;
          if (!seen.has(key)) {
            seen.add(key);
            tiles.push({ z, x: tx, y: ty });
          }
        }
      }
      navigator.serviceWorker?.controller?.postMessage({
        type: 'START_ZONE_SLOPE_PIPELINE',
        profile,
        zone: zone.hash,
        ring: zone.ring,
        tiles,
      });
    } catch {
      /* best-effort */
    }
  };

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
    setSlopeVisibility(map, enabledRef.current);
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
      setSlopeVisibility(map, enabledRef.current);
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
    setSlopeVisibility(map, enabledRef.current);

    // ── Zone multi-fetch on resolution switch ──
    if (sourceOptions.zone?.bounds) {
      triggerZonePipeline(sourceOptions.zone, sourceOptions.demProfile);
    }
  }, [map, isMapLoaded, sourceKey, sourceOptions]);

  // ── Active-state notification ─────────────────────────────────────
  // Tells the SW to grow the DEM hot tier when slope is on (it reads ~5×
  // more DEM tiles than the basemap).
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    notifySlopeActiveState(enabled);
    if (!enabled) return;

    if (sourceOptionsRef.current.zone?.bounds) {
      triggerZonePipeline(sourceOptionsRef.current.zone, sourceOptionsRef.current.demProfile);
    }
  }, [map, isMapLoaded, enabled]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    setSlopeVisibility(map, enabled);
  }, [map, isMapLoaded, enabled]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (!enabled) {
      visibilityDeferredRef.current = false;
      if (mountedRef.current) setSlopeVisibility(map, false);
      return;
    }

    visibilityDeferredRef.current = false;
    if (mountedRef.current) setSlopeVisibility(map, true);

    const resumeSlope = () => {
      if (!enabledRef.current) return;
      if (!canStartSlopeWork(map)) return;
      if (mountedRef.current) {
        setSlopeVisibility(map, true);
      }
    };

    map.on('moveend', resumeSlope);
    map.on('zoomend', resumeSlope);
    map.on('sourcedata', resumeSlope);
    map.on('styledata', resumeSlope);
    map.on('idle', resumeSlope);
    return () => {
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

    // Smooth hide without tearing down source, keeping 3D terrain graph 100% stable
    if (mountedRef.current) {
      setSlopeVisibility(map, false);
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