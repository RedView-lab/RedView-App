import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import {
  SHADOW_SOURCE_ID,
  SHADOW_LAYER_ID,
  buildShadowTileSource,
  buildShadowLayer,
  buildShadowPaint,
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
 * Manages DEM-driven terrain shadows on the Mapbox map.
 *
 * The old SW-generated raster mask has been retired here because it behaved as
 * a screen-darkening overlay on pitched 3D views. We now use a hillshade layer
 * backed directly by the live terrain DEM, which produces relief-aware shading
 * that follows the actual terrain model.
 */
export function useShadowTiles(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  opts: UseShadowTilesOptions,
): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const prevSourceKeyRef = useRef('');

  const shadowEnabled = opts.enabled;

  // Add / remove layer as the feature toggles.
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (!shadowEnabled) {
      removeShadow(map);
      prevSourceKeyRef.current = '';
      return;
    }

    ensureShadowPresentation(map, optsRef.current);

    return () => {
      if (map.getStyle()) removeShadow(map);
    };
  }, [map, isMapLoaded, shadowEnabled]);

  // Update the live hillshade paint as the sun moves or opacity changes.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!shadowEnabled) return;
    ensureShadowPresentation(map, opts);
    if (!map.getLayer(SHADOW_LAYER_ID)) return;

    syncShadowPaint(map, opts);
  }, [map, isMapLoaded, shadowEnabled, opts.opacity, opts.sunAzimuthDeg, opts.sunAltitudeDeg]);

  // Re-add after a style reload.
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      setTimeout(() => {
        if (!optsRef.current.enabled) return;
        ensureShadowPresentation(map, optsRef.current);
        syncShadowPaint(map, optsRef.current);
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => {
      map.off('style.load', onStyleLoad);
    };
  }, [map, isMapLoaded, shadowEnabled]);

  // Re-attach when the DEM source finishes loading or when Mapbox drops the
  // layer during internal style/source churn.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!shadowEnabled) return;

    const onSourceData = () => {
      ensureShadowPresentation(map, optsRef.current);
      syncShadowPaint(map, optsRef.current);
    };

    map.on('sourcedata', onSourceData);
    return () => {
      map.off('sourcedata', onSourceData);
    };
  }, [map, isMapLoaded, shadowEnabled]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (map && map.getStyle()) {
        removeShadow(map);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function shadowVisibility(altitudeDeg: number): number {
    const t = Math.max(0, Math.min(1, (altitudeDeg + 2.5) / 6.5));
    return t * t * (3 - 2 * t);
  }

  function effectiveShadowAltitude(altitudeDeg: number): number {
    return Math.max(0.15, altitudeDeg);
  }

  function ensureShadowPresentation(m: MapboxMap, o: UseShadowTilesOptions) {
    const visibility = shadowVisibility(o.sunAltitudeDeg);
    if (visibility <= 0) return;

    const azRounded = parseFloat(o.sunAzimuthDeg.toFixed(1));
    const altRounded = parseFloat(effectiveShadowAltitude(o.sunAltitudeDeg).toFixed(1));
    const sourceKey = `${azRounded}_${altRounded}`;

    if (sourceKey !== prevSourceKeyRef.current || !m.getSource(SHADOW_SOURCE_ID)) {
      prevSourceKeyRef.current = sourceKey;
      try {
        if (m.getLayer(SHADOW_LAYER_ID)) m.removeLayer(SHADOW_LAYER_ID);
      } catch {
        /* layer may not exist yet */
      }
      try {
        if (m.getSource(SHADOW_SOURCE_ID)) m.removeSource(SHADOW_SOURCE_ID);
      } catch {
        /* source may not exist yet */
      }

      try {
        m.addSource(SHADOW_SOURCE_ID, buildShadowTileSource(azRounded, altRounded) as any);
      } catch (err) {
        console.warn('[shadow] addSource failed', err);
        return;
      }
    }

    if (m.getLayer(SHADOW_LAYER_ID)) return;

    try {
      m.addLayer(buildShadowLayer({
        opacity: o.opacity,
        sunAltitudeDeg: o.sunAltitudeDeg,
      }) as any);
    } catch (err) {
      console.warn('[shadow] addLayer failed', err);
    }
  }

  function syncShadowPaint(m: MapboxMap, o: UseShadowTilesOptions) {
    const paint = buildShadowPaint(o);
    try {
      m.setPaintProperty(SHADOW_LAYER_ID, 'raster-opacity', paint['raster-opacity']);
      m.setPaintProperty(SHADOW_LAYER_ID, 'raster-resampling', paint['raster-resampling']);
      m.setPaintProperty(SHADOW_LAYER_ID, 'raster-fade-duration', paint['raster-fade-duration']);
      m.setPaintProperty(SHADOW_LAYER_ID, 'raster-color-mix', paint['raster-color-mix']);
      m.setPaintProperty(SHADOW_LAYER_ID, 'raster-color-range', paint['raster-color-range']);
      m.setPaintProperty(SHADOW_LAYER_ID, 'raster-color', paint['raster-color'] as unknown as string);
      m.triggerRepaint();
    } catch {
      /* layer may not exist yet */
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
