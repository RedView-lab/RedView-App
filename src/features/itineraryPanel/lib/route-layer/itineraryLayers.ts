import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl';

import {
  CASING_PREFIX,
  DIRT_PATTERN_PREFIX,
  GLOW_PREFIX,
  GRAVEL_PATTERN_PREFIX,
  LINE_PREFIX,
  PAVED_PATTERN_PREFIX,
  SAND_PATTERN_PREFIX,
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
import { buildRouteContentSignature } from '../routes';

const ROUTE_LINE_ELEVATION_REFERENCE = 'ground' as unknown as undefined;
const ROUTE_LINE_Z_OFFSET = 0 as unknown as undefined;

const routeLineMetricsState = new WeakMap<MapboxMap, Map<string, boolean>>();
// Per-map signature cache: sourceId -> last applied option+content signature.
// Lets upsertRouteLayer skip setData / paint-property churn when nothing
// (geometry, color, width, opacity, render mode, slope bands) has changed —
// which is the common case during styledata/sourcedata storms.
const routeAppliedSignatureState = new WeakMap<MapboxMap, Map<string, string>>();

function getRouteAppliedSignatureRegistry(map: MapboxMap): Map<string, string> {
  let registry = routeAppliedSignatureState.get(map);
  if (!registry) {
    registry = new Map<string, string>();
    routeAppliedSignatureState.set(map, registry);
  }
  return registry;
}

function buildRouteOptionSignature(opts: RouteLayerOptions, contentSignature: string): string {
  const slopeBandsSignature = opts.slopeBands
    ? opts.slopeBands.map((band) => `${band.id}:${band.minDeg}:${band.maxDeg}:${band.color}`).join(',')
    : '';
  return [
    contentSignature,
    opts.color,
    opts.opacity01,
    opts.visible ? 1 : 0,
    normalizeTraceWidthPx(opts.traceWidthPx),
    opts.renderMode ?? 'default',
    slopeBandsSignature,
  ].join('|');
}

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

function removeLayerIfPresent(map: MapboxMap, layerId: string): void {
  try {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  } catch {
    /* map may be tearing down */
  }
}

function syncPatternLayer(
  map: MapboxMap,
  params: {
    layerId: string;
    sourceId: string;
    visibility: 'visible' | 'none';
    opacity: number;
    colorPaint: string | unknown[] | null;
    widthPx: number;
    dasharray: number[] | null;
    filter: unknown[] | null;
    lineCap: 'butt' | 'round';
  },
): void {
  const {
    layerId,
    sourceId,
    visibility,
    opacity,
    colorPaint,
    widthPx,
    dasharray,
    filter,
    lineCap,
  } = params;

  if (!colorPaint || !(widthPx > 0) || !filter) {
    removeLayerIfPresent(map, layerId);
    return;
  }

  if (!map.getLayer(layerId)) {
    map.addLayer({
      id: layerId,
      type: 'line',
      source: sourceId,
      slot: 'top',
      filter: filter as never,
      layout: {
        'line-cap': lineCap,
        'line-join': 'round',
        'line-elevation-reference': ROUTE_LINE_ELEVATION_REFERENCE,
        'line-z-offset': ROUTE_LINE_Z_OFFSET,
        visibility,
      },
      paint: {
        'line-color': colorPaint as never,
        'line-width': widthPx,
        'line-opacity': opacity,
        'line-dasharray': dasharray as never,
        'line-emissive-strength': 1,
        'line-occlusion-opacity': 0,
      },
    });
    return;
  }

  map.setPaintProperty(layerId, 'line-color', colorPaint as never);
  setPaintPropertyIfChanged(map, layerId, 'line-width', widthPx);
  setPaintPropertyIfChanged(map, layerId, 'line-opacity', opacity);
  setPaintPropertyIfChanged(map, layerId, 'line-dasharray', dasharray);
  setLayoutPropertyIfChanged(map, layerId, 'line-cap', lineCap);
  setLayoutPropertyIfChanged(map, layerId, 'line-join', 'round');
  setLayoutPropertyIfChanged(map, layerId, 'line-elevation-reference', ROUTE_LINE_ELEVATION_REFERENCE);
  setLayoutPropertyIfChanged(map, layerId, 'line-z-offset', ROUTE_LINE_Z_OFFSET);
  setLayoutPropertyIfChanged(map, layerId, 'visibility', visibility);
  map.setFilter(layerId, filter as never);
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
  const {
    source: srcId,
    casing: casingId,
    glow: legacyGlowId,
    pavedPattern: pavedPatternId,
    gravelPattern: gravelPatternId,
    dirtPattern: dirtPatternId,
    sandPattern: sandPatternId,
    line: lineId,
  } = ids(itineraryId);
  const visibility = opts.visible ? 'visible' : 'none';
  const opacity = Math.max(0, Math.min(1, opts.opacity01));
  const traceWidthPx = normalizeTraceWidthPx(opts.traceWidthPx);
  const lineMetricsRegistry = getRouteLineMetricsRegistry(map);
  const appliedSignatureRegistry = getRouteAppliedSignatureRegistry(map);
  const contentSignature = buildRouteContentSignature(points);
  const optionSignature = buildRouteOptionSignature(opts, contentSignature);

  let existing = map.getSource(srcId) as GeoJSONSource | undefined;

  // If the route is hidden:
  if (!opts.visible) {
    if (existing || map.getLayer(lineId)) {
      setRouteLayerVisibility(map, itineraryId, false);
      appliedSignatureRegistry.set(itineraryId, optionSignature);
    }
    return;
  }

  // Short-circuit: if the source already existed and nothing changed, do nothing.
  if (existing && appliedSignatureRegistry.get(itineraryId) === optionSignature) {
    try {
      raiseRouteLayer(map, itineraryId);
    } catch {
      /* map may be tearing down */
    }
    return;
  }

  const renderSpec = buildRouteGeoJson(points, opts, traceWidthPx);
  const mountedSourceRequiresLineMetrics = getMountedSourceRequiresLineMetrics(map, srcId);
  const mountedLayerUsesLineProgress = routeLayerUsesLineGradient(map, lineId)
    || routeLayerUsesLineGradient(map, legacyGlowId)
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
      removeLayerIfPresent(map, casingId);
      removeLayerIfPresent(map, legacyGlowId);
      removeLayerIfPresent(map, pavedPatternId);
      removeLayerIfPresent(map, gravelPatternId);
      removeLayerIfPresent(map, dirtPatternId);
      removeLayerIfPresent(map, sandPatternId);
      removeLayerIfPresent(map, lineId);
      if (map.getSource(srcId)) map.removeSource(srcId);
    } catch {
      /* noop */
    }
    lineMetricsRegistry.delete(itineraryId);
    appliedSignatureRegistry.delete(itineraryId);
    existing = undefined;
  }

  if (existing) {
    try {
      existing.setData(renderSpec.data);
    } catch {
      /* noop */
    }
  } else {
    if (!canMutateStyle(map)) return;
    map.addSource(srcId, {
      type: 'geojson',
      lineMetrics: true,
      data: renderSpec.data,
    });
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
    lineMetricsRegistry.set(itineraryId, renderSpec.requiresLineMetrics);
  }

  appliedSignatureRegistry.set(itineraryId, optionSignature);

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
    syncPatternLayer(map, {
      layerId: legacyGlowId,
      sourceId: srcId,
      visibility,
      opacity,
      colorPaint: null,
      widthPx: 0,
      dasharray: null,
      filter: null,
      lineCap: 'butt',
    });
    syncPatternLayer(map, {
      layerId: pavedPatternId,
      sourceId: srcId,
      visibility,
      opacity,
      colorPaint: renderSpec.pavedPattern?.colorPaint ?? null,
      widthPx: renderSpec.pavedPattern?.widthPx ?? 0,
      dasharray: renderSpec.pavedPattern?.dasharray ?? null,
      filter: renderSpec.pavedPattern?.filter ?? null,
      lineCap: renderSpec.pavedPattern?.lineCap ?? 'butt',
    });
    syncPatternLayer(map, {
      layerId: gravelPatternId,
      sourceId: srcId,
      visibility,
      opacity,
      colorPaint: renderSpec.gravelPattern?.colorPaint ?? null,
      widthPx: renderSpec.gravelPattern?.widthPx ?? 0,
      dasharray: renderSpec.gravelPattern?.dasharray ?? null,
      filter: renderSpec.gravelPattern?.filter ?? null,
      lineCap: renderSpec.gravelPattern?.lineCap ?? 'butt',
    });
    syncPatternLayer(map, {
      layerId: dirtPatternId,
      sourceId: srcId,
      visibility,
      opacity,
      colorPaint: renderSpec.dirtPattern?.colorPaint ?? null,
      widthPx: renderSpec.dirtPattern?.widthPx ?? 0,
      dasharray: renderSpec.dirtPattern?.dasharray ?? null,
      filter: renderSpec.dirtPattern?.filter ?? null,
      lineCap: renderSpec.dirtPattern?.lineCap ?? 'butt',
    });
    syncPatternLayer(map, {
      layerId: sandPatternId,
      sourceId: srcId,
      visibility,
      opacity,
      colorPaint: renderSpec.sandPattern?.colorPaint ?? null,
      widthPx: renderSpec.sandPattern?.widthPx ?? 0,
      dasharray: renderSpec.sandPattern?.dasharray ?? null,
      filter: renderSpec.sandPattern?.filter ?? null,
      lineCap: renderSpec.sandPattern?.lineCap ?? 'round',
    });
    lineMetricsRegistry.set(itineraryId, renderSpec.requiresLineMetrics);
    raiseRouteLayer(map, itineraryId);
  } catch {
    /* map may be tearing down */
  }
}

export function raiseRouteLayer(map: MapboxMap, itineraryId: string): void {
  const {
    casing: casingId,
    glow: legacyGlowId,
    pavedPattern: pavedPatternId,
    gravelPattern: gravelPatternId,
    dirtPattern: dirtPatternId,
    sandPattern: sandPatternId,
    line: lineId,
  } = ids(itineraryId);
  try {
    if (!hasRasterLayerAbove(map, lineId)) return;
    if (map.getLayer(casingId)) map.moveLayer(casingId);
    if (map.getLayer(lineId)) map.moveLayer(lineId);
    if (map.getLayer(legacyGlowId)) map.moveLayer(legacyGlowId);
    if (map.getLayer(pavedPatternId)) map.moveLayer(pavedPatternId);
    if (map.getLayer(gravelPatternId)) map.moveLayer(gravelPatternId);
    if (map.getLayer(dirtPatternId)) map.moveLayer(dirtPatternId);
    if (map.getLayer(sandPatternId)) map.moveLayer(sandPatternId);
  } catch {
    /* map may be tearing down */
  }
}

export function removeRouteLayer(map: MapboxMap, itineraryId: string): void {
  const {
    source: srcId,
    casing: casingId,
    glow: legacyGlowId,
    pavedPattern: pavedPatternId,
    gravelPattern: gravelPatternId,
    dirtPattern: dirtPatternId,
    sandPattern: sandPatternId,
    line: lineId,
  } = ids(itineraryId);
  try {
    removeLayerIfPresent(map, casingId);
    removeLayerIfPresent(map, pavedPatternId);
    removeLayerIfPresent(map, gravelPatternId);
    removeLayerIfPresent(map, dirtPatternId);
    removeLayerIfPresent(map, sandPatternId);
    removeLayerIfPresent(map, legacyGlowId);
    removeLayerIfPresent(map, lineId);
    if (map.getSource(srcId)) map.removeSource(srcId);
    routeLineMetricsState.get(map)?.delete(itineraryId);
    routeAppliedSignatureState.get(map)?.delete(itineraryId);
  } catch {
    /* noop */
  }
}

export function setRouteLayerVisibility(
  map: MapboxMap,
  itineraryId: string,
  visible: boolean,
): void {
  const {
    casing: casingId,
    glow: legacyGlowId,
    pavedPattern: pavedPatternId,
    gravelPattern: gravelPatternId,
    dirtPattern: dirtPatternId,
    sandPattern: sandPatternId,
    line: lineId,
  } = ids(itineraryId);
  const visibility = visible ? 'visible' : 'none';
  try {
    if (map.getLayer(casingId)) setLayoutPropertyIfChanged(map, casingId, 'visibility', visibility);
    if (map.getLayer(legacyGlowId)) setLayoutPropertyIfChanged(map, legacyGlowId, 'visibility', visibility);
    if (map.getLayer(pavedPatternId)) setLayoutPropertyIfChanged(map, pavedPatternId, 'visibility', visibility);
    if (map.getLayer(gravelPatternId)) setLayoutPropertyIfChanged(map, gravelPatternId, 'visibility', visibility);
    if (map.getLayer(dirtPatternId)) setLayoutPropertyIfChanged(map, dirtPatternId, 'visibility', visibility);
    if (map.getLayer(sandPatternId)) setLayoutPropertyIfChanged(map, sandPatternId, 'visibility', visibility);
    if (map.getLayer(lineId)) setLayoutPropertyIfChanged(map, lineId, 'visibility', visibility);
  } catch {
    /* noop */
  }
}

export function removeAllRouteLayers(map: MapboxMap): void {
  try {
    const style = map.getStyle();
    if (!style?.sources) return;
    routeLineMetricsState.get(map)?.clear();
    routeAppliedSignatureState.get(map)?.clear();
    for (const key of Object.keys(style.sources)) {
      if (!key.startsWith(SOURCE_PREFIX)) continue;
      const safe = key.slice(SOURCE_PREFIX.length);
      const casingId = `${CASING_PREFIX}${safe}`;
      const glowId = `${GLOW_PREFIX}${safe}`;
      const pavedPatternId = `${PAVED_PATTERN_PREFIX}${safe}`;
      const gravelPatternId = `${GRAVEL_PATTERN_PREFIX}${safe}`;
      const dirtPatternId = `${DIRT_PATTERN_PREFIX}${safe}`;
      const sandPatternId = `${SAND_PATTERN_PREFIX}${safe}`;
      const lineId = `${LINE_PREFIX}${safe}`;
      try {
        removeLayerIfPresent(map, casingId);
        removeLayerIfPresent(map, pavedPatternId);
        removeLayerIfPresent(map, gravelPatternId);
        removeLayerIfPresent(map, dirtPatternId);
        removeLayerIfPresent(map, sandPatternId);
        removeLayerIfPresent(map, glowId);
        removeLayerIfPresent(map, lineId);
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