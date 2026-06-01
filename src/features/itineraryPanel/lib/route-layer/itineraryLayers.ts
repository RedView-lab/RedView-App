import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl';

import {
  CASING_PREFIX,
  GLOW_PREFIX,
  LINE_PREFIX,
  SOURCE_PREFIX,
  canMutateStyle,
  ids,
} from './constants';
import {
  buildRouteGeoJson,
  inferMountedRouteUsesLineGradient,
  normalizeTraceWidthPx,
  type RouteLayerOptions,
  type RouteLayerPoint,
} from './routeStyle';

const ROUTE_LINE_ELEVATION_REFERENCE = 'ground' as unknown as undefined;
const ROUTE_LINE_Z_OFFSET = 0 as unknown as undefined;

const routeLineMetricsState = new WeakMap<MapboxMap, Map<string, boolean>>();

function getRouteLineMetricsRegistry(map: MapboxMap): Map<string, boolean> {
  let registry = routeLineMetricsState.get(map);
  if (!registry) {
    registry = new Map<string, boolean>();
    routeLineMetricsState.set(map, registry);
  }
  return registry;
}

function hasRasterLayerAbove(map: MapboxMap, layerId: string): boolean {
  try {
    const layers = map.getStyle()?.layers ?? [];
    const index = layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) return false;
    return layers.slice(index + 1).some((layer) => layer.type === 'raster');
  } catch {
    return false;
  }
}

function getMountedSourceRequiresLineMetrics(map: MapboxMap, sourceId: string): boolean | null {
  try {
    const source = map.getStyle()?.sources?.[sourceId] as { lineMetrics?: boolean } | undefined;
    return typeof source?.lineMetrics === 'boolean' ? source.lineMetrics : null;
  } catch {
    return null;
  }
}

function routeLayerUsesLineGradient(map: MapboxMap, layerId: string): boolean {
  try {
    return Boolean(map.getLayer(layerId) && map.getPaintProperty(layerId, 'line-gradient') != null);
  } catch {
    return false;
  }
}

function setPaintPropertyIfChanged(
  map: MapboxMap,
  layerId: string,
  property: Parameters<MapboxMap['setPaintProperty']>[1],
  value: unknown,
): void {
  try {
    if (map.getPaintProperty(layerId, property) !== value) {
      map.setPaintProperty(layerId, property, value as never);
    }
  } catch {
    /* map may be tearing down */
  }
}

function setLayoutPropertyIfChanged(
  map: MapboxMap,
  layerId: string,
  property: Parameters<MapboxMap['setLayoutProperty']>[1],
  value: unknown,
): void {
  try {
    if (map.getLayoutProperty(layerId, property) !== value) {
      map.setLayoutProperty(layerId, property, value as never);
    }
  } catch {
    /* map may be tearing down */
  }
}

export function hasRouteLayer(map: MapboxMap, itineraryId: string): boolean {
  try {
    return !!map.getSource(ids(itineraryId).source);
  } catch {
    return false;
  }
}

export function isAnyRouteOnMap(map: MapboxMap): boolean {
  try {
    const style = map.getStyle();
    if (!style?.sources) return false;
    for (const key of Object.keys(style.sources)) {
      if (key.startsWith(SOURCE_PREFIX)) return true;
    }
  } catch {
    /* noop */
  }
  return false;
}

export function upsertRouteLayer(
  map: MapboxMap,
  itineraryId: string,
  points: RouteLayerPoint[],
  opts: RouteLayerOptions,
): void {
  const { source: srcId, casing: casingId, glow: glowId, line: lineId } = ids(itineraryId);
  const visibility = opts.visible ? 'visible' : 'none';
  const opacity = Math.max(0, Math.min(1, opts.opacity01));
  const traceWidthPx = normalizeTraceWidthPx(opts.traceWidthPx);
  const renderSpec = buildRouteGeoJson(points, opts, traceWidthPx);
  const lineMetricsRegistry = getRouteLineMetricsRegistry(map);

  let existing = map.getSource(srcId) as GeoJSONSource | undefined;
  const mountedSourceRequiresLineMetrics = getMountedSourceRequiresLineMetrics(map, srcId);
  const mountedLayerUsesLineProgress = routeLayerUsesLineGradient(map, lineId)
    || routeLayerUsesLineGradient(map, glowId)
    || routeLayerUsesLineGradient(map, casingId)
    || inferMountedRouteUsesLineGradient(map, lineId) === true;
  const mountedRegistryRequiresLineMetrics = lineMetricsRegistry.get(itineraryId);
  const mountedSourceLineMetricsMismatch = renderSpec.requiresLineMetrics
    ? mountedSourceRequiresLineMetrics !== true
    : mountedSourceRequiresLineMetrics === true;
  const shouldRecreateSource = existing && (
    mountedSourceLineMetricsMismatch
    || (mountedRegistryRequiresLineMetrics != null && mountedRegistryRequiresLineMetrics !== renderSpec.requiresLineMetrics)
    || (mountedLayerUsesLineProgress && !renderSpec.requiresLineMetrics)
  );

  if (shouldRecreateSource) {
    try {
      if (map.getLayer(casingId)) map.removeLayer(casingId);
      if (map.getLayer(lineId)) map.removeLayer(lineId);
      if (map.getLayer(glowId)) map.removeLayer(glowId);
      if (map.getSource(srcId)) map.removeSource(srcId);
    } catch {
      /* noop */
    }
    lineMetricsRegistry.delete(itineraryId);
    existing = undefined;
  }

  if (existing) {
    try {
      existing.setData(renderSpec.data);
    } catch {
      /* noop */
    }
    try {
      if (map.getLayer(casingId)) map.removeLayer(casingId);
      if (map.getLayer(glowId)) map.removeLayer(glowId);
    } catch {
      /* noop */
    }
  } else {
    if (!canMutateStyle(map)) return;
    map.addSource(srcId, {
      type: 'geojson',
      lineMetrics: renderSpec.requiresLineMetrics,
      data: renderSpec.data,
    });
    if (renderSpec.casingColorPaint && renderSpec.casingFilter && renderSpec.casingWidthPx > traceWidthPx) {
      map.addLayer({
        id: casingId,
        type: 'line',
        source: srcId,
        slot: 'top',
        filter: renderSpec.casingFilter as never,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-elevation-reference': ROUTE_LINE_ELEVATION_REFERENCE,
          'line-z-offset': ROUTE_LINE_Z_OFFSET,
          visibility,
        },
        paint: {
          'line-color': renderSpec.casingColorPaint as never,
          'line-width': renderSpec.casingWidthPx,
          'line-opacity': opacity,
          'line-emissive-strength': 1,
          'line-occlusion-opacity': 0,
        },
      });
    }
    map.addLayer({
      id: lineId,
      type: 'line',
      source: srcId,
      slot: 'top',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        'line-elevation-reference': ROUTE_LINE_ELEVATION_REFERENCE,
        'line-z-offset': ROUTE_LINE_Z_OFFSET,
        visibility,
      },
      paint: {
        'line-color': renderSpec.lineColorPaint as never,
        'line-width': traceWidthPx,
        'line-opacity': opacity,
        'line-emissive-strength': 1,
        'line-occlusion-opacity': 0,
        'line-border-width': renderSpec.lineBorderWidthPx,
        'line-border-color': renderSpec.lineBorderColorPaint as never,
        ...(renderSpec.lineGradientPaint ? { 'line-gradient': renderSpec.lineGradientPaint as never } : {}),
      },
    });
    if (renderSpec.overlayColorPaint && renderSpec.overlayWidthPx > 0) {
      map.addLayer({
        id: glowId,
        type: 'line',
        source: srcId,
        slot: 'top',
        filter: renderSpec.overlayFilter as never,
        layout: {
          'line-cap': 'butt',
          'line-join': 'round',
          'line-elevation-reference': ROUTE_LINE_ELEVATION_REFERENCE,
          'line-z-offset': ROUTE_LINE_Z_OFFSET,
          visibility,
        },
        paint: {
          'line-color': renderSpec.overlayColorPaint as never,
          'line-width': renderSpec.overlayWidthPx,
          'line-opacity': opacity,
          'line-dasharray': renderSpec.overlayDasharray as never,
          'line-emissive-strength': 1,
          'line-occlusion-opacity': 0,
        },
      });
    }
    lineMetricsRegistry.set(itineraryId, renderSpec.requiresLineMetrics);
  }

  try {
    if (map.getLayer(lineId)) {
      map.setPaintProperty(lineId, 'line-color', renderSpec.lineColorPaint as never);
      if (renderSpec.lineGradientPaint) {
        map.setPaintProperty(lineId, 'line-gradient', renderSpec.lineGradientPaint as never);
      } else if (map.getPaintProperty(lineId, 'line-gradient') != null) {
        map.setPaintProperty(lineId, 'line-gradient', null as never);
      }
      map.setPaintProperty(lineId, 'line-border-color', renderSpec.lineBorderColorPaint as never);
      setLayoutPropertyIfChanged(map, lineId, 'line-elevation-reference', ROUTE_LINE_ELEVATION_REFERENCE);
      setLayoutPropertyIfChanged(map, lineId, 'line-z-offset', ROUTE_LINE_Z_OFFSET);
      setPaintPropertyIfChanged(map, lineId, 'line-width', traceWidthPx);
      setPaintPropertyIfChanged(map, lineId, 'line-opacity', opacity);
      setPaintPropertyIfChanged(map, lineId, 'line-border-width', renderSpec.lineBorderWidthPx);
      setLayoutPropertyIfChanged(map, lineId, 'visibility', visibility);
    }
    if (renderSpec.casingColorPaint && renderSpec.casingFilter && renderSpec.casingWidthPx > traceWidthPx) {
      if (!map.getLayer(casingId)) {
        map.addLayer({
          id: casingId,
          type: 'line',
          source: srcId,
          slot: 'top',
          filter: renderSpec.casingFilter as never,
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-elevation-reference': ROUTE_LINE_ELEVATION_REFERENCE,
            'line-z-offset': ROUTE_LINE_Z_OFFSET,
            visibility,
          },
          paint: {
            'line-color': renderSpec.casingColorPaint as never,
            'line-width': renderSpec.casingWidthPx,
            'line-opacity': opacity,
            'line-emissive-strength': 1,
            'line-occlusion-opacity': 0,
          },
        }, lineId);
      } else {
        map.setPaintProperty(casingId, 'line-color', renderSpec.casingColorPaint as never);
        setPaintPropertyIfChanged(map, casingId, 'line-width', renderSpec.casingWidthPx);
        setPaintPropertyIfChanged(map, casingId, 'line-opacity', opacity);
        setLayoutPropertyIfChanged(map, casingId, 'line-cap', 'round');
        setLayoutPropertyIfChanged(map, casingId, 'line-join', 'round');
        setLayoutPropertyIfChanged(map, casingId, 'line-elevation-reference', ROUTE_LINE_ELEVATION_REFERENCE);
        setLayoutPropertyIfChanged(map, casingId, 'line-z-offset', ROUTE_LINE_Z_OFFSET);
        setLayoutPropertyIfChanged(map, casingId, 'visibility', visibility);
        map.setFilter(casingId, renderSpec.casingFilter as never);
      }
    } else if (map.getLayer(casingId)) {
      map.removeLayer(casingId);
    }
    if (renderSpec.overlayColorPaint && renderSpec.overlayWidthPx > 0) {
      if (!map.getLayer(glowId)) {
        map.addLayer({
          id: glowId,
          type: 'line',
          source: srcId,
          slot: 'top',
          filter: renderSpec.overlayFilter as never,
          layout: {
            'line-cap': 'butt',
            'line-join': 'round',
            'line-elevation-reference': ROUTE_LINE_ELEVATION_REFERENCE,
            'line-z-offset': ROUTE_LINE_Z_OFFSET,
            visibility,
          },
          paint: {
            'line-color': renderSpec.overlayColorPaint as never,
            'line-width': renderSpec.overlayWidthPx,
            'line-opacity': opacity,
            'line-dasharray': renderSpec.overlayDasharray as never,
            'line-emissive-strength': 1,
            'line-occlusion-opacity': 0,
          },
        });
      } else {
        map.setPaintProperty(glowId, 'line-color', renderSpec.overlayColorPaint as never);
        setPaintPropertyIfChanged(map, glowId, 'line-width', renderSpec.overlayWidthPx);
        setPaintPropertyIfChanged(map, glowId, 'line-opacity', opacity);
        setPaintPropertyIfChanged(map, glowId, 'line-dasharray', renderSpec.overlayDasharray);
        setLayoutPropertyIfChanged(map, glowId, 'line-cap', 'butt');
        setLayoutPropertyIfChanged(map, glowId, 'line-join', 'round');
        setLayoutPropertyIfChanged(map, glowId, 'line-elevation-reference', ROUTE_LINE_ELEVATION_REFERENCE);
        setLayoutPropertyIfChanged(map, glowId, 'line-z-offset', ROUTE_LINE_Z_OFFSET);
        setLayoutPropertyIfChanged(map, glowId, 'visibility', visibility);
        if (renderSpec.overlayFilter) {
          map.setFilter(glowId, renderSpec.overlayFilter as never);
        }
      }
    } else if (map.getLayer(glowId)) {
      map.removeLayer(glowId);
    }
    lineMetricsRegistry.set(itineraryId, renderSpec.requiresLineMetrics);
    raiseRouteLayer(map, itineraryId);
  } catch {
    /* map may be tearing down */
  }
}

export function raiseRouteLayer(map: MapboxMap, itineraryId: string): void {
  const { casing: casingId, glow: glowId, line: lineId } = ids(itineraryId);
  try {
    if (!hasRasterLayerAbove(map, lineId)) return;
    if (map.getLayer(casingId)) map.moveLayer(casingId);
    if (map.getLayer(lineId)) map.moveLayer(lineId);
    if (map.getLayer(glowId)) map.moveLayer(glowId);
  } catch {
    /* map may be tearing down */
  }
}

export function removeRouteLayer(map: MapboxMap, itineraryId: string): void {
  const { source: srcId, casing: casingId, glow: glowId, line: lineId } = ids(itineraryId);
  try {
    if (map.getLayer(casingId)) map.removeLayer(casingId);
    if (map.getLayer(lineId)) map.removeLayer(lineId);
    if (map.getLayer(glowId)) map.removeLayer(glowId);
    if (map.getSource(srcId)) map.removeSource(srcId);
    routeLineMetricsState.get(map)?.delete(itineraryId);
  } catch {
    /* noop */
  }
}

export function setRouteLayerVisibility(
  map: MapboxMap,
  itineraryId: string,
  visible: boolean,
): void {
  const { casing: casingId, glow: glowId, line: lineId } = ids(itineraryId);
  const visibility = visible ? 'visible' : 'none';
  try {
    if (map.getLayer(casingId)) map.setLayoutProperty(casingId, 'visibility', visibility);
    if (map.getLayer(glowId)) map.setLayoutProperty(glowId, 'visibility', visibility);
    if (map.getLayer(lineId)) map.setLayoutProperty(lineId, 'visibility', visibility);
  } catch {
    /* noop */
  }
}

export function removeAllRouteLayers(map: MapboxMap): void {
  try {
    const style = map.getStyle();
    if (!style?.sources) return;
    routeLineMetricsState.get(map)?.clear();
    for (const key of Object.keys(style.sources)) {
      if (!key.startsWith(SOURCE_PREFIX)) continue;
      const safe = key.slice(SOURCE_PREFIX.length);
      const casingId = `${CASING_PREFIX}${safe}`;
      const glowId = `${GLOW_PREFIX}${safe}`;
      const lineId = `${LINE_PREFIX}${safe}`;
      try {
        if (map.getLayer(casingId)) map.removeLayer(casingId);
        if (map.getLayer(lineId)) map.removeLayer(lineId);
        if (map.getLayer(glowId)) map.removeLayer(glowId);
        if (map.getSource(key)) map.removeSource(key);
      } catch {
        /* noop */
      }
    }
  } catch {
    /* noop */
  }
}

export function listMountedRouteIds(map: MapboxMap): string[] {
  const out: string[] = [];
  try {
    const style = map.getStyle();
    if (!style?.sources) return out;
    for (const key of Object.keys(style.sources)) {
      if (key.startsWith(SOURCE_PREFIX)) {
        out.push(key.slice(SOURCE_PREFIX.length));
      }
    }
  } catch {
    /* noop */
  }
  return out;
}