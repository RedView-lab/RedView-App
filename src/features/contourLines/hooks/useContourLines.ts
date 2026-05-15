import { useEffect, useRef } from 'react';
import type { DataDrivenPropertyValueSpecification, Map as MapboxMap } from 'mapbox-gl';
import {
  buildContourCasingLayer,
  buildContourLineLayer,
  buildContourPaints,
  buildContourSource,
  CONTOUR_CASING_LAYER_ID,
  CONTOUR_LAYER_PREFIX,
  CONTOUR_LINE_LAYER_ID,
  CONTOUR_SOURCE_ID,
} from '../lib/contour-source';

function findFirstSymbolLayerId(map: MapboxMap): string | undefined {
  return map.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id;
}

function nativeContourLayerIds(map: MapboxMap): string[] {
  return (map.getStyle()?.layers ?? [])
    .filter((layer) => {
      const id = layer.id.toLowerCase();
      const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
      return !id.startsWith(CONTOUR_LAYER_PREFIX)
        && (sourceLayer === 'contour' || id.includes('contour'));
    })
    .map((layer) => layer.id);
}

function hideNativeContourLayers(map: MapboxMap) {
  for (const layerId of nativeContourLayerIds(map)) {
    try {
      map.setLayoutProperty(layerId, 'visibility', 'none');
    } catch {
      /* style may still be transitioning */
    }
  }
}

function addContourLayers(map: MapboxMap, opacity: number, intervalMeters: number) {
  try {
    hideNativeContourLayers(map);
    if (!map.getSource(CONTOUR_SOURCE_ID)) {
      map.addSource(CONTOUR_SOURCE_ID, buildContourSource());
    }
    const beforeId = findFirstSymbolLayerId(map);
    if (!map.getLayer(CONTOUR_CASING_LAYER_ID)) {
      map.addLayer(
        buildContourCasingLayer(opacity, intervalMeters) as Parameters<MapboxMap['addLayer']>[0],
        beforeId,
      );
    }
    if (!map.getLayer(CONTOUR_LINE_LAYER_ID)) {
      map.addLayer(
        buildContourLineLayer(opacity, intervalMeters) as Parameters<MapboxMap['addLayer']>[0],
        beforeId,
      );
    }
  } catch {
    /* style may be transitioning */
  }
}

function removeContourLayers(map: MapboxMap) {
  try {
    if (map.getLayer(CONTOUR_LINE_LAYER_ID)) map.removeLayer(CONTOUR_LINE_LAYER_ID);
    if (map.getLayer(CONTOUR_CASING_LAYER_ID)) map.removeLayer(CONTOUR_CASING_LAYER_ID);
    if (map.getSource(CONTOUR_SOURCE_ID)) map.removeSource(CONTOUR_SOURCE_ID);
  } catch {
    /* style may be transitioning */
  }
}

function setContourVisibility(map: MapboxMap, visible: boolean) {
  for (const layerId of [CONTOUR_CASING_LAYER_ID, CONTOUR_LINE_LAYER_ID]) {
    try {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
      }
    } catch {
      /* layer may not exist yet */
    }
  }
}

function updateContourPaint(map: MapboxMap, opacity: number, intervalMeters: number) {
  const paints = buildContourPaints(opacity, intervalMeters);
  const casingOpacity = paints.casingOpacity as unknown as DataDrivenPropertyValueSpecification<number>;
  const casingWidth = paints.casingWidth as unknown as DataDrivenPropertyValueSpecification<number>;
  const lineOpacity = paints.lineOpacity as unknown as DataDrivenPropertyValueSpecification<number>;
  const lineWidth = paints.lineWidth as unknown as DataDrivenPropertyValueSpecification<number>;
  try {
    if (map.getLayer(CONTOUR_CASING_LAYER_ID)) {
      map.setPaintProperty(CONTOUR_CASING_LAYER_ID, 'line-opacity', casingOpacity);
      map.setPaintProperty(CONTOUR_CASING_LAYER_ID, 'line-width', casingWidth);
    }
    if (map.getLayer(CONTOUR_LINE_LAYER_ID)) {
      map.setPaintProperty(CONTOUR_LINE_LAYER_ID, 'line-opacity', lineOpacity);
      map.setPaintProperty(CONTOUR_LINE_LAYER_ID, 'line-width', lineWidth);
    }
  } catch {
    /* style may be transitioning */
  }
}

export function useContourLines(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  intervalMeters: number,
  available: boolean,
) {
  const mountedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const opacityRef = useRef(opacity);
  const intervalRef = useRef(intervalMeters);
  const availableRef = useRef(available);

  useEffect(() => {
    enabledRef.current = enabled;
    opacityRef.current = opacity;
    intervalRef.current = intervalMeters;
    availableRef.current = available;
  }, [enabled, opacity, intervalMeters, available]);

  useEffect(() => {
    if (!map || !isMapLoaded || !available) return;
    if (mountedRef.current) {
      hideNativeContourLayers(map);
      return;
    }
    addContourLayers(map, opacityRef.current, intervalRef.current);
    mountedRef.current = true;
    setContourVisibility(map, enabledRef.current && availableRef.current);
  }, [map, isMapLoaded, available]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    setContourVisibility(map, enabled && available);
  }, [map, isMapLoaded, enabled, available]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    updateContourPaint(map, opacity, intervalMeters);
  }, [map, isMapLoaded, opacity, intervalMeters]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (!availableRef.current) return;
        addContourLayers(map, opacityRef.current, intervalRef.current);
        mountedRef.current = true;
        setContourVisibility(map, enabledRef.current && availableRef.current);
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
        if (map.getStyle && map.getStyle()) removeContourLayers(map);
      } catch {
        /* map already destroyed */
      }
      mountedRef.current = false;
    };
  }, [map]);
}