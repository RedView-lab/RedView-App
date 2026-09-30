import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { AltitudeCategory, AltitudeColorMode } from '../types';
import {
  ALTITUDE_LAYER_ID,
  ALTITUDE_SOURCE_ID,
  type AltitudeTileSourceOptions,
  buildAltitudeColorExpression,
  buildAltitudeLayer,
  buildAltitudeSourceKey,
  buildAltitudeTileSource,
  getAltitudeEncoding,
} from '../lib/altitude-source';
import type { OverlayStatusReporter } from '@/features/map3d';
import { useAltitudeLoadStatus } from './useAltitudeLoadStatus';

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clearAltitudeCache = () => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_ALTITUDE_CACHE' });
    console.log('[altitude][debug] CLEAR_ALTITUDE_CACHE sent — reload to fetch fresh tiles.');
  };
}

const DEFAULT_SOURCE_OPTIONS: AltitudeTileSourceOptions = { zone: null };

function postToServiceWorker(message: Record<string, unknown>): void {
  try {
    navigator.serviceWorker?.controller?.postMessage(message);
  } catch {
    /* service worker may not control this page yet */
  }
}

interface AltitudeLayerProps {
  opacity: number;
  colorMode: AltitudeColorMode;
  categories: AltitudeCategory[];
  hiddenIds: ReadonlySet<string>;
  sourceOptions: AltitudeTileSourceOptions;
}

function removeAltitudeLayer(map: MapboxMap): void {
  try {
    if (map.getLayer(ALTITUDE_LAYER_ID)) map.removeLayer(ALTITUDE_LAYER_ID);
    if (map.getSource(ALTITUDE_SOURCE_ID)) map.removeSource(ALTITUDE_SOURCE_ID);
  } catch {
    /* style may be transitioning or map already destroyed */
  }
}

function setAltitudeVisibility(map: MapboxMap, visible: boolean): void {
  try {
    if (map.getLayer(ALTITUDE_LAYER_ID)) {
      map.setLayoutProperty(ALTITUDE_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
    }
  } catch {
    /* style may be transitioning */
  }
}

/**
 * Idempotent: makes the altitude source + layer exist for `sourceKey` and be
 * visible. Swaps the source when the key changed (3D quality / DEM profile /
 * zone). Returns false when the style is not ready yet — caller retries.
 */
function ensureAltitudeLayer(
  map: MapboxMap,
  sourceKey: string,
  mountedKeyRef: { current: string | null },
  props: AltitudeLayerProps,
): boolean {
  try {
    const hasLayer = Boolean(map.getLayer(ALTITUDE_LAYER_ID));
    if (hasLayer && mountedKeyRef.current === sourceKey) {
      setAltitudeVisibility(map, true);
      return true;
    }
    if (hasLayer || map.getSource(ALTITUDE_SOURCE_ID)) removeAltitudeLayer(map);
    mountedKeyRef.current = null;

    map.addSource(ALTITUDE_SOURCE_ID, buildAltitudeTileSource(props.sourceOptions));
    const layer = buildAltitudeLayer(
      props.opacity,
      props.colorMode,
      props.categories,
      props.hiddenIds,
      getAltitudeEncoding(props.sourceOptions),
    );
    map.addLayer(layer as Parameters<MapboxMap['addLayer']>[0]);
    mountedKeyRef.current = sourceKey;
    return true;
  } catch {
    return false;
  }
}

/**
 * Altitude (hypsometric tint) overlay.
 *
 * The overlay never computes elevation itself: it re-reads the DEM tiles the
 * 3D terrain already loaded and colours them on the GPU (`raster-color`).
 * Disabling only hides the layer — Mapbox stops requesting its tiles and a
 * re-enable repaints instantly from the GPU/HTTP caches.
 */
export function useAltitude(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  colorMode: AltitudeColorMode,
  categories: AltitudeCategory[],
  hiddenBandIds?: ReadonlyArray<string>,
  sourceOptions: AltitudeTileSourceOptions = DEFAULT_SOURCE_OPTIONS,
  onLoadStatusChange?: OverlayStatusReporter,
) {
  const hiddenIds = useMemo(() => new Set(hiddenBandIds ?? []), [hiddenBandIds]);
  const sourceKey = buildAltitudeSourceKey(sourceOptions);
  const usesServiceWorker = getAltitudeEncoding(sourceOptions) === 'mapbox';

  // Latest paint/source props, read when (re)building the layer so the mount
  // effect doesn't re-run on every slider tick.
  // Layout effect: synced before any passive effect below reads them.
  const propsRef = useRef<AltitudeLayerProps>({ opacity, colorMode, categories, hiddenIds, sourceOptions });
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    propsRef.current = { opacity, colorMode, categories, hiddenIds, sourceOptions };
    enabledRef.current = enabled;
  });
  const mountedKeyRef = useRef<string | null>(null);

  // ── Mount / swap / visibility / style reload ─────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!enabled) {
      setAltitudeVisibility(map, false);
      return;
    }

    let cancelled = false;
    let deferTimer: ReturnType<typeof setTimeout> | null = null;

    const attempt = () => {
      if (cancelled || !enabledRef.current) return;
      if (ensureAltitudeLayer(map, sourceKey, mountedKeyRef, propsRef.current)) {
        map.triggerRepaint();
        return;
      }
      // Style not ready: one-shot retry on the next style event — never a
      // persistent `sourcedata` listener (fires per tile during loads).
      map.once('styledata', attempt);
    };

    // A basemap switch wipes every custom layer; re-add once the new style
    // has settled (next tick, so base layers land first and slot order holds).
    const onStyleLoad = () => {
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

  // ── Service-Worker pressure (HD / zone path only) ─────────────────────
  // The fast-30m path streams straight from AWS and never touches the SW.
  useEffect(() => {
    if (!map || !isMapLoaded || !enabled || !usesServiceWorker) return;
    postToServiceWorker({ type: 'ALTITUDE_ACTIVE_STATE', active: true });
    return () => {
      postToServiceWorker({ type: 'ALTITUDE_ACTIVE_STATE', active: false });
      postToServiceWorker({ type: 'CANCEL_ALTITUDE_WORK' });
    };
  }, [map, isMapLoaded, enabled, usesServiceWorker]);

  // ── Paint ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    try {
      if (map.getLayer(ALTITUDE_LAYER_ID)) {
        map.setPaintProperty(ALTITUDE_LAYER_ID, 'raster-opacity', opacity);
      }
    } catch {
      /* style may be transitioning */
    }
  }, [map, isMapLoaded, opacity]);

  useEffect(() => {
    if (!map || !isMapLoaded || !categories.length) return;
    try {
      if (map.getLayer(ALTITUDE_LAYER_ID)) {
        const expr = buildAltitudeColorExpression(categories, colorMode, hiddenIds);
        map.setPaintProperty(ALTITUDE_LAYER_ID, 'raster-color', expr as unknown as string);
      }
    } catch {
      /* style may be transitioning */
    }
  }, [map, isMapLoaded, colorMode, categories, hiddenIds]);

  // ── Teardown ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map) return;
    return () => {
      removeAltitudeLayer(map);
      mountedKeyRef.current = null;
    };
  }, [map]);

  useAltitudeLoadStatus(map, isMapLoaded, enabled, sourceKey, onLoadStatusChange);
}
