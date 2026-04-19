import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import {
  SHADOW_SOURCE_ID,
  SHADOW_LAYER_ID,
  buildShadowTileSource,
  buildShadowLayer,
} from '../lib/shadow-source';

export interface UseShadowTilesOptions {
  enabled: boolean;
  /** Sun azimuth in degrees (0=N, 90=E, 180=S, 270=W) */
  sunAzimuthDeg: number;
  /** Sun altitude in degrees (-90..+90) */
  sunAltitudeDeg: number;
  /** Shadow overlay opacity 0..1 */
  opacity: number;
}

/**
 * Manages the shadow tile raster overlay on the Mapbox map.
 *
 * When the sun position changes (debounced), the source is recreated with new
 * query parameters so the SW computes fresh shadow tiles for the new angle.
 */
export function useShadowTiles(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  opts: UseShadowTilesOptions,
): void {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevKeyRef = useRef<string>('');

  // Add / update / remove shadow source + layer
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (!opts.enabled || opts.sunAltitudeDeg <= 0) {
      // Remove if present
      removeShadow(map);
      prevKeyRef.current = '';
      return;
    }

    // Debounce sun position updates to avoid re-creating source on every
    // frame during time slider scrubbing. 150 ms is enough now that the
    // sweep-line shadow computation is near-instant (~10 ms per tile).
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      applyShadow(map, opts);
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    map,
    isMapLoaded,
    opts.enabled,
    // Round to 1 decimal to avoid too-frequent updates
    Math.round(opts.sunAzimuthDeg * 10),
    Math.round(opts.sunAltitudeDeg * 10),
  ]);

  // Update opacity immediately (no debounce needed — no tile refetch)
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!opts.enabled) return;
    if (!map.getLayer(SHADOW_LAYER_ID)) return;
    try {
      map.setPaintProperty(SHADOW_LAYER_ID, 'raster-opacity', opts.opacity);
    } catch { /* layer may not exist yet */ }
  }, [map, isMapLoaded, opts.enabled, opts.opacity]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (map && map.getStyle()) {
        removeShadow(map);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyShadow(m: MapboxMap, o: UseShadowTilesOptions) {
    const azRounded = parseFloat(o.sunAzimuthDeg.toFixed(1));
    const altRounded = parseFloat(o.sunAltitudeDeg.toFixed(1));
    const key = `${azRounded}_${altRounded}`;

    if (key === prevKeyRef.current && m.getSource(SHADOW_SOURCE_ID)) return;
    prevKeyRef.current = key;

    // Remove existing source + layer before re-adding
    removeShadow(m);

    try {
      m.addSource(SHADOW_SOURCE_ID, buildShadowTileSource(azRounded, altRounded) as any);
      m.addLayer(buildShadowLayer(o.opacity) as any);
    } catch (err) {
      console.warn('[shadow] addSource/addLayer failed', err);
    }
  }
}

function removeShadow(map: MapboxMap): void {
  try {
    if (map.getLayer(SHADOW_LAYER_ID)) map.removeLayer(SHADOW_LAYER_ID);
  } catch { /* */ }
  try {
    if (map.getSource(SHADOW_SOURCE_ID)) map.removeSource(SHADOW_SOURCE_ID);
  } catch { /* */ }
}
