import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { SlopeCategory, SlopeColorMode, SlopeDemProfile } from '../../types';
import {
  SLOPE_LAYER_ID,
  type SlopeTileSourceOptions,
  type SlopeZoneOptions,
  buildSlopeColorExpression,
  buildSlopeSourceKey,
} from '../../lib/slope-source';
import {
  addSlopeLayer,
  hiddenIdsFromRanges,
  notifySlopeActiveState,
  removeSlopeLayer,
  setSlopeVisibility,
} from './helpers';
import { useSlopeProgressReporter } from './progress';

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clearSlopeCache = () => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_SLOPE_CACHE' });
    console.log('[slope][debug] CLEAR_SLOPE_CACHE sent — reload to fetch fresh tiles.');
  };
}

const DEFAULT_SOURCE_OPTIONS: SlopeTileSourceOptions = { demProfile: 'default', resolutionFactor: 1 };

interface SlopeLayerProps {
  opacity: number;
  colorMode: SlopeColorMode;
  categories: SlopeCategory[];
  hiddenIds: Set<string>;
  sourceOptions: SlopeTileSourceOptions;
}

type ZonePipelineStamp = { hash: string; profile: string; time: number } | null;

function startZonePipeline(
  zone: SlopeZoneOptions,
  profile: SlopeDemProfile,
  lastRef: { current: ZonePipelineStamp },
): void {
  const now = Date.now();
  const last = lastRef.current;
  if (last && last.hash === zone.hash && last.profile === profile && now - last.time < 1000) return;
  lastRef.current = { hash: zone.hash, profile, time: now };

  try {
    const [w, s, e, n] = zone.bounds;
    const tiles: Array<{ z: number; x: number; y: number }> = [];
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
        tiles.push({ z, x: tx, y: ty });
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
}

/**
 * Idempotent: makes the slope source + layer exist for `sourceKey` and be
 * visible, swapping the source when the key changed (DEM profile /
 * resolution / zone). Returns null when the style is not ready (caller
 * retries), otherwise whether a swap/fresh add happened.
 */
function ensureSlopeLayer(
  map: MapboxMap,
  sourceKey: string,
  mountedKeyRef: { current: string | null },
  props: SlopeLayerProps,
): { added: boolean } | null {
  try {
    const hasLayer = Boolean(map.getLayer(SLOPE_LAYER_ID));
    if (hasLayer && mountedKeyRef.current === sourceKey) {
      setSlopeVisibility(map, true);
      return { added: false };
    }
    removeSlopeLayer(map);
    mountedKeyRef.current = null;
    const ok = addSlopeLayer(
      map,
      props.opacity,
      props.colorMode,
      props.categories,
      props.hiddenIds,
      props.sourceOptions,
    );
    if (!ok) return null;
    mountedKeyRef.current = sourceKey;
    setSlopeVisibility(map, true);
    return { added: true };
  } catch {
    return null;
  }
}

/**
 * Slope overlay. Disabling only hides the layer (source kept, so the 3D
 * terrain graph stays stable and a re-enable repaints from cache).
 */
export function useSlope(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  colorMode: SlopeColorMode,
  hiddenRanges?: ReadonlyArray<readonly [number, number]>,
  categories?: SlopeCategory[],
  sourceOptions: SlopeTileSourceOptions = DEFAULT_SOURCE_OPTIONS,
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
  const hiddenKey = useMemo(() => Array.from(hiddenIds).sort().join(','), [hiddenIds]);
  const sourceKey = useMemo(() => buildSlopeSourceKey(sourceOptions), [sourceOptions]);

  // Layout effect: synced before any passive effect below reads them.
  const propsRef = useRef<SlopeLayerProps>({
    opacity, colorMode, categories: categories ?? [], hiddenIds, sourceOptions,
  });
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    propsRef.current = { opacity, colorMode, categories: categories ?? [], hiddenIds, sourceOptions };
    enabledRef.current = enabled;
  });

  const mountedRef = useRef(false);
  const mountedKeyRef = useRef<string | null>(null);
  const lastZonePipelineRef = useRef<ZonePipelineStamp>(null);

  // ── Mount / swap / visibility / style reload ─────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!enabled) {
      setSlopeVisibility(map, false);
      return;
    }

    let cancelled = false;
    let deferTimer: ReturnType<typeof setTimeout> | null = null;

    const attempt = () => {
      if (cancelled || !enabledRef.current) return;
      const hadMountedKey = mountedKeyRef.current;
      const result = ensureSlopeLayer(map, sourceKey, mountedKeyRef, propsRef.current);
      if (!result) {
        mountedRef.current = false;
        // Style not ready: one-shot retry, never a persistent per-tile listener.
        map.once('styledata', attempt);
        return;
      }
      mountedRef.current = true;
      if (result.added) {
        map.triggerRepaint();
        // Resolution / profile switch on a zone → re-run the zone multi-fetch.
        const { zone, demProfile } = propsRef.current.sourceOptions;
        if (hadMountedKey && zone?.bounds) startZonePipeline(zone, demProfile, lastZonePipelineRef);
      }
    };

    // A basemap switch wipes custom layers; re-add on the next tick so base
    // layers land first and slot order holds.
    const onStyleLoad = () => {
      mountedRef.current = false;
      mountedKeyRef.current = null;
      if (deferTimer) clearTimeout(deferTimer);
      deferTimer = setTimeout(attempt, 0);
    };

    attempt();
    map.on('style.load', onStyleLoad);
    return () => {
      cancelled = true;
      if (deferTimer) clearTimeout(deferTimer);
      map.off('styledata', attempt);
      map.off('style.load', onStyleLoad);
    };
  }, [map, isMapLoaded, enabled, sourceKey]);

  // ── Active-state notification ─────────────────────────────────────
  // Tells the SW to grow the DEM hot tier when slope is on (it reads ~5×
  // more DEM tiles than the basemap), and kicks the zone pipeline.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    notifySlopeActiveState(enabled);
    if (!enabled) return;
    const { zone, demProfile } = propsRef.current.sourceOptions;
    if (zone?.bounds) startZonePipeline(zone, demProfile, lastZonePipelineRef);
  }, [map, isMapLoaded, enabled]);

  // ── Paint ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    try {
      if (map.getLayer(SLOPE_LAYER_ID)) {
        map.setPaintProperty(SLOPE_LAYER_ID, 'raster-opacity', opacity);
      }
    } catch {
      /* style may be transitioning */
    }
  }, [map, isMapLoaded, opacity]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const { categories: cats, colorMode: mode, hiddenIds: hidden } = propsRef.current;
    if (!cats.length) return;
    try {
      if (map.getLayer(SLOPE_LAYER_ID)) {
        const expression = buildSlopeColorExpression(cats, mode, hidden);
        map.setPaintProperty(SLOPE_LAYER_ID, 'raster-color', expression as unknown as string);
      }
    } catch {
      /* style may be transitioning */
    }
  }, [map, isMapLoaded, colorMode, categoriesKey, hiddenKey]);

  // ── Teardown ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map) return;
    return () => {
      removeSlopeLayer(map);
      mountedRef.current = false;
      mountedKeyRef.current = null;
    };
  }, [map]);

  useSlopeProgressReporter({
    map,
    isMapLoaded,
    enabled,
    onLoadStatusChange,
    mountedRef,
  });
}
