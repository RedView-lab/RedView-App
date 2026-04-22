import { useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { AltitudeCategory, AltitudeColorMode } from '../types';
import {
  ALTITUDE_LAYER_ID,
  ALTITUDE_SOURCE_ID,
  buildAltitudeColorExpression,
  buildAltitudeLayer,
  buildAltitudeTileSource,
} from '../lib/altitude-source';

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
  resolutionFactor: number,
) {
  try {
    if (!map.getSource(ALTITUDE_SOURCE_ID)) {
      map.addSource(ALTITUDE_SOURCE_ID, buildAltitudeTileSource(resolutionFactor));
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
  resolutionFactor: number = 1,
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
  const resolutionFactorRef = useRef(resolutionFactor);
  opacityRef.current = opacity;
  colorModeRef.current = colorMode;
  enabledRef.current = enabled;
  categoriesRef.current = categories;
  hiddenIdsRef.current = hiddenIds;
  resolutionFactorRef.current = resolutionFactor;

  const mountedRef = useRef(false);
  const mountedResolutionRef = useRef<number | null>(null);

  useEffect(() => {
    if (!map || !isMapLoaded || !enabled) return;
    if (mountedRef.current) return;
    addAltitudeLayer(
      map,
      opacityRef.current,
      colorModeRef.current,
      categoriesRef.current,
      hiddenIdsRef.current,
      resolutionFactorRef.current,
    );
    mountedRef.current = true;
    mountedResolutionRef.current = resolutionFactorRef.current;
  }, [map, isMapLoaded, enabled]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    if (mountedResolutionRef.current === resolutionFactor) return;
    removeAltitudeLayer(map);
    mountedRef.current = false;
    addAltitudeLayer(map, opacityRef.current, colorModeRef.current, categoriesRef.current, hiddenIdsRef.current, resolutionFactor);
    mountedRef.current = true;
    mountedResolutionRef.current = resolutionFactor;
    setAltitudeVisibility(map, enabledRef.current);
  }, [map, isMapLoaded, resolutionFactor]);

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
      mountedResolutionRef.current = null;
      setTimeout(() => {
        if (!enabledRef.current) return;
        addAltitudeLayer(
          map,
          opacityRef.current,
          colorModeRef.current,
          categoriesRef.current,
          hiddenIdsRef.current,
          resolutionFactorRef.current,
        );
        mountedRef.current = true;
        mountedResolutionRef.current = resolutionFactorRef.current;
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
}