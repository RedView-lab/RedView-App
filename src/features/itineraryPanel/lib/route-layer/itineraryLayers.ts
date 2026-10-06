import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl';

import {
  CASING_PREFIX,
  DIRT_PATTERN_PREFIX,
  GLOW_PREFIX,
  GRAVEL_PATTERN_PREFIX,
  LINE_PREFIX,
  OUTLINE_PREFIX,
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
  ROUTE_OUTLINE_COLOR,
  type RouteLayerOptions,
  type RouteLayerPoint,
} from './routeStyle';
import {
  getRouteElevationContext,
  getRouteLineElevation,
  type RouteLineElevationReference,
} from './routeElevation';
import { buildRouteContentSignature } from '../routes';
import { planActiveRouteRestack } from './routeStacking';

const ROUTE_LINE_OCCLUSION_OPACITY = 0;

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

function buildRouteOptionSignature(
  opts: RouteLayerOptions,
  contentSignature: string,
  elevationSignature: string,
): string {
  const slopeBandsSignature = opts.slopeBands
    ? opts.slopeBands.map((band) => `${band.id}:${band.minDeg}:${band.maxDeg}:${band.color}`).join(',')
    : '';
  return [
    contentSignature,
    elevationSignature,
    opts.color,
    opts.opacity01,
    opts.visible ? 1 : 0,
    normalizeTraceWidthPx(opts.traceWidthPx),
    opts.renderMode ?? 'default',
    slopeBandsSignature,
    opts.surfaceFilter ?? 'all',
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

export function getMountedSourceRequiresLineMetrics(map: MapboxMap, sourceId: string): boolean | null {
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

export function setPaintPropertyIfChanged(
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

export function setLayoutPropertyIfChanged(
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
    elevationReference: RouteLineElevationReference;
    zOffset: number;
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
    elevationReference,
    zOffset,
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
        'line-elevation-reference': elevationReference,
        'line-z-offset': zOffset,
        visibility,
      },
      paint: {
        'line-color': colorPaint as never,
        'line-width': widthPx,
        'line-opacity': opacity,
        'line-dasharray': dasharray as never,
        'line-emissive-strength': 1,
        'line-occlusion-opacity': ROUTE_LINE_OCCLUSION_OPACITY,
      },
    });
    return;
  }

  map.setPaintProperty(layerId, 'line-color', colorPaint as never);
  setPaintPropertyIfChanged(map, layerId, 'line-width', widthPx);
  setPaintPropertyIfChanged(map, layerId, 'line-opacity', opacity);
  setPaintPropertyIfChanged(map, layerId, 'line-dasharray', dasharray);
  setPaintPropertyIfChanged(map, layerId, 'line-occlusion-opacity', ROUTE_LINE_OCCLUSION_OPACITY);
  setLayoutPropertyIfChanged(map, layerId, 'line-cap', lineCap);
  setLayoutPropertyIfChanged(map, layerId, 'line-join', 'round');
  setLayoutPropertyIfChanged(map, layerId, 'line-elevation-reference', elevationReference);
  setLayoutPropertyIfChanged(map, layerId, 'line-z-offset', zOffset);
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

/**
 * Mounts or updates one itinerary's trace. Returns false when the map could
 * not take it (style being replaced, map tearing down): the caller must retry,
 * the applied signature is only recorded once every layer is in place.
 */
export function upsertRouteLayer(
  map: MapboxMap,
  itineraryId: string,
  points: RouteLayerPoint[],
  opts: RouteLayerOptions,
): boolean {
  const {
    source: srcId,
    outline: outlineId,
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
  const optionSignature = buildRouteOptionSignature(opts, contentSignature, getRouteElevationContext(map).signature);

  let existing = map.getSource(srcId) as GeoJSONSource | undefined;

  // If the route is hidden:
  if (!opts.visible) {
    if (existing || map.getLayer(lineId)) {
      setRouteLayerVisibility(map, itineraryId, false);
      appliedSignatureRegistry.set(itineraryId, optionSignature);
    }
    return true;
  }

  // Short-circuit: if the trace is mounted and nothing changed, do nothing.
  if (
    existing
    && map.getLayer(lineId)
    && map.getLayer(outlineId)
    && appliedSignatureRegistry.get(itineraryId) === optionSignature
  ) {
    try {
      raiseRouteLayer(map, itineraryId);
    } catch {
      /* map may be tearing down */
    }
    return true;
  }
  appliedSignatureRegistry.delete(itineraryId);

  const renderSpec = buildRouteGeoJson(points, opts, traceWidthPx);
  renderSpec.requiresLineMetrics = true;
  const { reference: elevationReference, zOffset } = getRouteLineElevation(map);
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
      removeLayerIfPresent(map, outlineId);
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

  try {
    if (existing) {
      existing.setData(renderSpec.data);
    } else {
      if (!canMutateStyle(map)) return false;
      map.addSource(srcId, {
        type: 'geojson',
        lineMetrics: true,
        tolerance: 0,
        data: renderSpec.data,
      });
    }
  } catch {
    return false;
  }

  try {
    if (!map.getLayer(lineId)) {
      map.addLayer({
        id: lineId,
        type: 'line',
        source: srcId,
        slot: 'top',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-elevation-reference': elevationReference,
          'line-z-offset': zOffset,
          visibility,
        },
        paint: {
          'line-color': renderSpec.lineColorPaint as never,
          'line-width': traceWidthPx,
          'line-opacity': opacity,
          'line-emissive-strength': 1,
          'line-occlusion-opacity': ROUTE_LINE_OCCLUSION_OPACITY,
          'line-border-width': renderSpec.lineBorderWidthPx,
          'line-border-color': renderSpec.lineBorderColorPaint as never,
          ...(renderSpec.lineGradientPaint ? { 'line-gradient': renderSpec.lineGradientPaint as never } : {}),
        },
      });
    } else {
      map.setPaintProperty(lineId, 'line-color', renderSpec.lineColorPaint as never);
      if (renderSpec.lineGradientPaint) {
        map.setPaintProperty(lineId, 'line-gradient', renderSpec.lineGradientPaint as never);
      } else if (map.getPaintProperty(lineId, 'line-gradient') != null) {
        map.setPaintProperty(lineId, 'line-gradient', null as never);
      }
      map.setPaintProperty(lineId, 'line-border-color', renderSpec.lineBorderColorPaint as never);
      setLayoutPropertyIfChanged(map, lineId, 'line-elevation-reference', elevationReference);
      setLayoutPropertyIfChanged(map, lineId, 'line-z-offset', zOffset);
      setPaintPropertyIfChanged(map, lineId, 'line-width', traceWidthPx);
      setPaintPropertyIfChanged(map, lineId, 'line-opacity', opacity);
      setPaintPropertyIfChanged(map, lineId, 'line-occlusion-opacity', ROUTE_LINE_OCCLUSION_OPACITY);
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
            'line-elevation-reference': elevationReference,
            'line-z-offset': zOffset,
            visibility,
          },
          paint: {
            'line-color': renderSpec.casingColorPaint as never,
            'line-width': renderSpec.casingWidthPx,
            'line-opacity': opacity,
            'line-emissive-strength': 1,
            'line-occlusion-opacity': ROUTE_LINE_OCCLUSION_OPACITY,
          },
        }, lineId);
      } else {
        map.setPaintProperty(casingId, 'line-color', renderSpec.casingColorPaint as never);
        setPaintPropertyIfChanged(map, casingId, 'line-width', renderSpec.casingWidthPx);
        setPaintPropertyIfChanged(map, casingId, 'line-opacity', opacity);
        setPaintPropertyIfChanged(map, casingId, 'line-occlusion-opacity', ROUTE_LINE_OCCLUSION_OPACITY);
        setLayoutPropertyIfChanged(map, casingId, 'line-cap', 'round');
        setLayoutPropertyIfChanged(map, casingId, 'line-join', 'round');
        setLayoutPropertyIfChanged(map, casingId, 'line-elevation-reference', elevationReference);
        setLayoutPropertyIfChanged(map, casingId, 'line-z-offset', zOffset);
        setLayoutPropertyIfChanged(map, casingId, 'visibility', visibility);
        map.setFilter(casingId, renderSpec.casingFilter as never);
      }
    } else if (map.getLayer(casingId)) {
      map.removeLayer(casingId);
    }
    // Contour sous le liseré et la trace (même source, mêmes tronçons).
    if (!map.getLayer(outlineId)) {
      map.addLayer({
        id: outlineId,
        type: 'line',
        source: srcId,
        slot: 'top',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-elevation-reference': elevationReference,
          'line-z-offset': zOffset,
          visibility,
        },
        paint: {
          'line-color': ROUTE_OUTLINE_COLOR,
          'line-width': renderSpec.outlineWidthPaint as never,
          'line-opacity': opacity,
          'line-emissive-strength': 1,
          'line-occlusion-opacity': ROUTE_LINE_OCCLUSION_OPACITY,
        },
      }, map.getLayer(casingId) ? casingId : lineId);
    } else {
      map.setPaintProperty(outlineId, 'line-width', renderSpec.outlineWidthPaint as never);
      setPaintPropertyIfChanged(map, outlineId, 'line-opacity', opacity);
      setPaintPropertyIfChanged(map, outlineId, 'line-occlusion-opacity', ROUTE_LINE_OCCLUSION_OPACITY);
      setLayoutPropertyIfChanged(map, outlineId, 'line-elevation-reference', elevationReference);
      setLayoutPropertyIfChanged(map, outlineId, 'line-z-offset', zOffset);
      setLayoutPropertyIfChanged(map, outlineId, 'visibility', visibility);
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
      elevationReference,
      zOffset,
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
      elevationReference,
      zOffset,
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
      elevationReference,
      zOffset,
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
      elevationReference,
      zOffset,
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
      elevationReference,
      zOffset,
    });
    lineMetricsRegistry.set(itineraryId, renderSpec.requiresLineMetrics);
    raiseRouteLayer(map, itineraryId);
  } catch {
    // Style being replaced / map tearing down: leave the signature unset so
    // the next replay rebuilds whatever is missing.
    return false;
  }
  appliedSignatureRegistry.set(itineraryId, optionSignature);
  return true;
}

export function raiseRouteLayer(map: MapboxMap, itineraryId: string): void {
  const {
    outline: outlineId,
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
    if (map.getLayer(outlineId)) map.moveLayer(outlineId);
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
    outline: outlineId,
    casing: casingId,
    glow: legacyGlowId,
    pavedPattern: pavedPatternId,
    gravelPattern: gravelPatternId,
    dirtPattern: dirtPatternId,
    sandPattern: sandPatternId,
    line: lineId,
  } = ids(itineraryId);
  try {
    removeLayerIfPresent(map, outlineId);
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
    outline: outlineId,
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
    if (map.getLayer(outlineId)) setLayoutPropertyIfChanged(map, outlineId, 'visibility', visibility);
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
      const outlineId = `${OUTLINE_PREFIX}${safe}`;
      const casingId = `${CASING_PREFIX}${safe}`;
      const glowId = `${GLOW_PREFIX}${safe}`;
      const pavedPatternId = `${PAVED_PATTERN_PREFIX}${safe}`;
      const gravelPatternId = `${GRAVEL_PATTERN_PREFIX}${safe}`;
      const dirtPatternId = `${DIRT_PATTERN_PREFIX}${safe}`;
      const sandPatternId = `${SAND_PATTERN_PREFIX}${safe}`;
      const lineId = `${LINE_PREFIX}${safe}`;
      try {
        removeLayerIfPresent(map, outlineId);
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

function routeLayerIds(itineraryId: string): string[] {
  const { source: _source, ...layers } = ids(itineraryId);
  return Object.values(layers);
}

/**
 * Le tracé de l'itinéraire sélectionné passe par-dessus les autres tracés
 * (cf. planActiveRouteRestack). Ne déplace une couche que si l'ordre est faux.
 */
export function stackActiveRouteOnTop(map: MapboxMap, activeItineraryId: string, itineraryIds: string[]): void {
  try {
    // L'ordre propre du style (`_order`), celui que `moveLayer` réordonne —
    // pas `style.order`, l'ordre de rendu (couches drapées d'abord, tri 3D).
    const order = (map as unknown as { style?: { _order?: string[] } }).style?._order
      ?? map.getStyle()?.layers?.map((layer) => layer.id);
    if (!order) return;
    const activeLayers = new Set(routeLayerIds(activeItineraryId));
    const otherLayers = new Set(
      itineraryIds
        .filter((id) => id !== activeItineraryId)
        .flatMap((id) => routeLayerIds(id)),
    );
    for (const { layerId, beforeId } of planActiveRouteRestack(order, activeLayers, otherLayers)) {
      map.moveLayer(layerId, beforeId);
    }
  } catch {
    /* style being replaced: the next replay restacks */
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