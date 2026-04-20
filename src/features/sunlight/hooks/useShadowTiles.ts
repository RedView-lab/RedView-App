import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import {
  SHADOW_SOURCE_ID,
  SHADOW_LAYER_ID,
  buildShadowLayer,
  buildShadowPaint,
} from '../lib/shadow-source';
import { unifiedDEMSource } from '../../map3d/lib/sources';

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

  const shadowEnabled = opts.enabled && opts.sunAltitudeDeg > 0;

  // Add / remove layer as the feature toggles.
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (!shadowEnabled) {
      removeShadow(map);
      return;
    }

    ensureShadowLayer(map, optsRef.current);

    return () => {
      if (map.getStyle()) removeShadow(map);
    };
  }, [map, isMapLoaded, shadowEnabled]);

  // Update the live hillshade paint as the sun moves or opacity changes.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!shadowEnabled) return;
    ensureShadowLayer(map, opts);
    if (!map.getLayer(SHADOW_LAYER_ID)) return;

    syncShadowPaint(map, opts);
  }, [map, isMapLoaded, shadowEnabled, opts.opacity, opts.sunAzimuthDeg, opts.sunAltitudeDeg]);

  // Re-add after a style reload.
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      setTimeout(() => {
        if (!shadowEnabled) return;
        ensureShadowLayer(map, optsRef.current);
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

    const onSourceData = (event: mapboxgl.MapSourceDataEvent) => {
      if (event.sourceId !== unifiedDEMSource.id) return;
      ensureShadowLayer(map, optsRef.current);
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

  function ensureShadowLayer(m: MapboxMap, o: UseShadowTilesOptions) {
    if (!m.getSource(unifiedDEMSource.id)) return;
    if (m.getLayer(SHADOW_LAYER_ID)) return;

    try {
      m.addLayer(buildShadowLayer({
        opacity: o.opacity,
        sunAzimuthDeg: o.sunAzimuthDeg,
        sunAltitudeDeg: o.sunAltitudeDeg,
      }) as any);
    } catch (err) {
      console.warn('[shadow] addLayer failed', err);
    }
  }

  function syncShadowPaint(m: MapboxMap, o: UseShadowTilesOptions) {
    const paint = buildShadowPaint(o);
    try {
      m.setPaintProperty(SHADOW_LAYER_ID, 'hillshade-illumination-anchor', paint['hillshade-illumination-anchor']);
      m.setPaintProperty(SHADOW_LAYER_ID, 'hillshade-illumination-direction', paint['hillshade-illumination-direction']);
      m.setPaintProperty(SHADOW_LAYER_ID, 'hillshade-exaggeration', paint['hillshade-exaggeration']);
      m.setPaintProperty(SHADOW_LAYER_ID, 'hillshade-shadow-color', paint['hillshade-shadow-color']);
      m.setPaintProperty(SHADOW_LAYER_ID, 'hillshade-highlight-color', paint['hillshade-highlight-color']);
      m.setPaintProperty(SHADOW_LAYER_ID, 'hillshade-accent-color', paint['hillshade-accent-color']);
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
