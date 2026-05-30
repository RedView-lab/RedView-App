/**
 * Mapbox layer helpers for the BRouter-computed routes.
 *
 * Each itinerary owns its own source + line layer pair, keyed
 * by its store id. That way several itineraries can be visible at once
 * (with their individual colors / opacities / visibilities) without the
 * layers stomping on one another.
 *
 * The start / end endpoint markers stay global â€” only the active
 * itinerary's endpoints are shown to keep the editing UI focused.
 */
import type { Map as MapboxMap, LngLatBoundsLike, GeoJSONSource } from 'mapbox-gl';
import {
  ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID,
  ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID,
  ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID,
  ANALYSIS_HOVER_SOURCE_ID,
  ANALYSIS_HOVER_HALO_LAYER_ID,
  ANALYSIS_HOVER_POINT_LAYER_ID,
  ENDPOINT_LAYER_ID,
  ENDPOINT_HANDLE_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID,
  FORBIDDEN_ZONE_FILL_LAYER_ID,
  FORBIDDEN_ZONE_LINE_LAYER_ID,
  GLOW_PREFIX,
  LINE_PREFIX,
  ROUTE_AUDIT_GLOW_LAYER_ID,
  ROUTE_AUDIT_LINE_LAYER_ID,
  SOURCE_PREFIX,
  START_SOURCE_ID,
  WAYPOINT_DRAG_CONNECTOR_LAYER_ID,
  WAYPOINT_DRAG_CONNECTOR_SOURCE_ID,
  canMutateStyle,
  ids,
} from './constants';
import {
  ensureAnalysisFlyoverProgressLayers,
  ensureAnalysisHoverLayers,
  ensureForbiddenZoneDraftLayers,
  ensureForbiddenZoneLayers,
  ensureRouteAuditLayers,
} from './auxiliaryLayers';
import {
  buildAnalysisFlyoverProgressGeoJson,
  buildAnalysisHoverGeoJson,
  buildForbiddenZoneDraftGeoJson,
  buildForbiddenZoneGeoJson,
  buildRouteAuditGeoJson,
} from './geojson';
import { haversineRouteDistanceM } from '../routes';
import type { TimelineItem } from '../../types';

export {
  ENDPOINT_LAYER_ID,
  ENDPOINT_HANDLE_HIT_LAYER_ID,
  START_SOURCE_ID,
  FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID,
} from './constants';

export interface RouteEndpoint {
  lon: number;
  lat: number;
  /** Used to pick the marker colour. */
  kind: 'start' | 'end' | 'waypoint';
  /** Timeline anchor id â€” lets the drag handler map a hit feature back to the row. */
  id?: string;
  label?: string;
}

/**
 * Build the draggable endpoint handles for an itinerary timeline: the start,
 * every intermediate waypoint, and the end. Each handle carries its timeline
 * anchor id so the map drag handler can reroute the matching segment.
 */
export function collectRouteEndpoints(
  timeline: ReadonlyArray<TimelineItem>,
): RouteEndpoint[] {
  const endpoints: RouteEndpoint[] = [];
  for (const row of timeline) {
    if (row.kind !== 'start' && row.kind !== 'waypoint' && row.kind !== 'end') continue;
    if (row.lat == null || row.lon == null) continue;
    endpoints.push({
      id: row.id,
      lon: row.lon,
      lat: row.lat,
      kind: row.kind,
      label: row.label,
    });
  }
  return endpoints;
}

export interface RouteLayerPoint {
  lat: number;
  lon: number;
  distanceM?: number | null;
  elevationM?: number | null;
  gradientPct?: number | null;
}

export interface RouteSlopeBand {
  id: string;
  minDeg: number;
  maxDeg: number;
  color: string;
}

type RouteRenderMode = 'default' | 'slope' | 'speedEst';

export interface RouteLayerOptions {
  /** CSS hex color (e.g. "#ff0000"). */
  color: string;
  /** Line opacity 0..1. */
  opacity01: number;
  /** Hide the layer without removing it. */
  visible: boolean;
  /** Main trace width in px. */
  traceWidthPx?: number;
  /** Alternate styling mode selected in the routes panel. */
  renderMode?: RouteRenderMode;
  /** Expert slope color bands used when renderMode === 'slope'. */
  slopeBands?: ReadonlyArray<RouteSlopeBand>;
}

interface RouteLayerRenderSpec {
  data: GeoJSON.Feature<GeoJSON.LineString>;
  lineColorPaint: string;
  lineGradientPaint: unknown[] | null;
  requiresLineMetrics: boolean;
}

const analysisHoverVisibilityState = new WeakMap<MapboxMap, boolean>();
const routeLineMetricsState = new WeakMap<MapboxMap, Map<string, boolean>>();

const ROUTE_SLOPE_TARGET_SEGMENT_M = 10;
const ROUTE_MIN_SEGMENT_DISTANCE_M = 0.5;

function normalizeTraceWidthPx(value: number | null | undefined): number {
  return Math.max(1, Math.min(12, Math.round(value ?? 4)));
}

function traceBorderWidthPx(traceWidthPx: number): number {
  return Math.max(0, Math.min(0, traceWidthPx * 0.25));
}

function getRouteLineMetricsRegistry(map: MapboxMap): Map<string, boolean> {
  let registry = routeLineMetricsState.get(map);
  if (!registry) {
    registry = new Map<string, boolean>();
    routeLineMetricsState.set(map, registry);
  }
  return registry;
}

function inferMountedRouteUsesLineGradient(map: MapboxMap, layerId: string): boolean | null {
  try {
    if (!map.getLayer(layerId)) return null;
    return map.getPaintProperty(layerId, 'line-gradient') != null;
  } catch {
    return null;
  }
}

function clampSlopeDeg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-90, Math.min(90, value));
}

function interpolateNumber(a: number, b: number, t: number): number {
  return a + ((b - a) * t);
}

function interpolateOptionalNumber(a: number | null | undefined, b: number | null | undefined, t: number): number | null {
  if (Number.isFinite(a) && Number.isFinite(b)) {
    return interpolateNumber(a as number, b as number, t);
  }
  if (Number.isFinite(a)) return a as number;
  if (Number.isFinite(b)) return b as number;
  return null;
}

function buildDefaultRouteGeoJson(
  points: readonly RouteLayerPoint[],
): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: points.map((point) => [point.lon, point.lat] as [number, number]),
    },
  };
}

function resolveSegmentDistanceM(start: RouteLayerPoint, end: RouteLayerPoint): number {
  const startDistance = start.distanceM;
  const endDistance = end.distanceM;
  if (Number.isFinite(startDistance) && Number.isFinite(endDistance)) {
    const delta = (endDistance as number) - (startDistance as number);
    if (delta > ROUTE_MIN_SEGMENT_DISTANCE_M) return delta;
  }
  return haversineRouteDistanceM(start, end);
}

function resolveSlopeDeg(start: RouteLayerPoint, end: RouteLayerPoint, distanceM: number): number {
  if (!(distanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) return 0;

  if (Number.isFinite(start.elevationM) && Number.isFinite(end.elevationM)) {
    const riseM = (end.elevationM as number) - (start.elevationM as number);
    return clampSlopeDeg((Math.atan(riseM / distanceM) * 180) / Math.PI);
  }

  const gradientCandidates = [start.gradientPct, end.gradientPct]
    .filter((value): value is number => Number.isFinite(value));

  if (gradientCandidates.length === 0) return 0;

  const avgGradientPct = gradientCandidates.reduce((sum, value) => sum + value, 0) / gradientCandidates.length;
  return clampSlopeDeg((Math.atan(avgGradientPct / 100) * 180) / Math.PI);
}

interface RouteSamplePoint {
  lon: number;
  lat: number;
  distanceM: number;
  elevationM: number | null;
  gradientPct: number | null;
}

function buildRouteSlopeSamples(points: readonly RouteLayerPoint[]): RouteSamplePoint[] {
  if (points.length === 0) return [];

  const samples: RouteSamplePoint[] = [];
  let cumulativeDistanceM = 0;

  const pushSample = (sample: RouteSamplePoint) => {
    const last = samples[samples.length - 1];
    if (
      last
      && Math.abs(last.distanceM - sample.distanceM) < 1e-6
      && last.lon === sample.lon
      && last.lat === sample.lat
    ) {
      samples[samples.length - 1] = sample;
      return;
    }
    samples.push(sample);
  };

  pushSample({
    lon: points[0].lon,
    lat: points[0].lat,
    distanceM: 0,
    elevationM: Number.isFinite(points[0].elevationM) ? (points[0].elevationM as number) : null,
    gradientPct: Number.isFinite(points[0].gradientPct) ? (points[0].gradientPct as number) : null,
  });

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentDistanceM = resolveSegmentDistanceM(start, end);
    if (!(segmentDistanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) continue;

    const subdivisionCount = Math.max(1, Math.ceil(segmentDistanceM / ROUTE_SLOPE_TARGET_SEGMENT_M));
    for (let partIndex = 1; partIndex <= subdivisionCount; partIndex += 1) {
      const t = partIndex / subdivisionCount;
      const targetDistanceM = cumulativeDistanceM + (segmentDistanceM * t);
      pushSample({
        lon: interpolateNumber(start.lon, end.lon, t),
        lat: interpolateNumber(start.lat, end.lat, t),
        distanceM: targetDistanceM,
        elevationM: interpolateOptionalNumber(start.elevationM, end.elevationM, t),
        gradientPct: interpolateOptionalNumber(start.gradientPct, end.gradientPct, t),
      });
    }

    cumulativeDistanceM += segmentDistanceM;
  }

  return samples;
}

function pickSlopeBand(
  bands: ReadonlyArray<RouteSlopeBand>,
  slopeDeg: number,
): RouteSlopeBand | null {
  if (bands.length === 0) return null;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const isLast = index === bands.length - 1;
    if (slopeDeg >= band.minDeg && (slopeDeg < band.maxDeg || isLast)) {
      return band;
    }
  }
  return bands[bands.length - 1] ?? null;
}

function buildUniformRouteGradientPaint(color: string): unknown[] {
  return ['interpolate', ['linear'], ['line-progress'], 0, color, 1, color];
}

function buildSlopeRouteGradientPaint(
  samples: readonly RouteSamplePoint[],
  bands: ReadonlyArray<RouteSlopeBand>,
  fallbackColor: string,
): unknown[] {
  if (samples.length < 2) return buildUniformRouteGradientPaint(fallbackColor);

  const totalDistanceM = samples[samples.length - 1]?.distanceM ?? 0;
  if (!(totalDistanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) {
    return buildUniformRouteGradientPaint(fallbackColor);
  }

  let currentColor = fallbackColor;
  for (let index = 1; index < samples.length; index += 1) {
    const start = samples[index - 1];
    const end = samples[index];
    const segmentDistanceM = end.distanceM - start.distanceM;
    if (!(segmentDistanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) continue;
    const segmentSlopeDeg = resolveSlopeDeg(start, end, segmentDistanceM);
    currentColor = pickSlopeBand(bands, segmentSlopeDeg)?.color ?? fallbackColor;
    break;
  }

  const expr: unknown[] = ['interpolate', ['linear'], ['line-progress'], 0, currentColor];
  let lastColor = currentColor;
  let lastStopProgress = 0;

  const pushStop = (progress: number, color: string) => {
    if (!(progress > lastStopProgress + 1e-6)) return;
    expr.push(progress, color);
    lastStopProgress = progress;
  };

  for (let index = 1; index < samples.length; index += 1) {
    const start = samples[index - 1];
    const end = samples[index];
    const segmentDistanceM = end.distanceM - start.distanceM;
    if (!(segmentDistanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) continue;

    const segmentSlopeDeg = resolveSlopeDeg(start, end, segmentDistanceM);
    const segmentColor = pickSlopeBand(bands, segmentSlopeDeg)?.color ?? fallbackColor;
    if (segmentColor === lastColor) continue;

    const startProgress = Math.max(0, Math.min(1, start.distanceM / totalDistanceM));
    const endProgress = Math.max(0, Math.min(1, end.distanceM / totalDistanceM));
    if (!(endProgress > startProgress)) continue;

    pushStop(startProgress, lastColor);
    pushStop(endProgress, segmentColor);
    lastColor = segmentColor;
  }

  pushStop(1, lastColor);
  return expr;
}

function buildSlopeRouteRenderSpec(
  points: readonly RouteLayerPoint[],
  bands: ReadonlyArray<RouteSlopeBand>,
  fallbackColor: string,
): RouteLayerRenderSpec {
  const samples = buildRouteSlopeSamples(points);
  return {
    data: buildDefaultRouteGeoJson(points),
    lineColorPaint: fallbackColor,
    lineGradientPaint: buildSlopeRouteGradientPaint(samples, bands, fallbackColor),
    requiresLineMetrics: true,
  };
}

function buildRouteGeoJson(
  points: readonly RouteLayerPoint[],
  opts: RouteLayerOptions,
): RouteLayerRenderSpec {
  if (opts.renderMode === 'slope') {
    return buildSlopeRouteRenderSpec(points, opts.slopeBands ?? [], opts.color);
  }
  return {
    data: buildDefaultRouteGeoJson(points),
    lineColorPaint: opts.color,
    lineGradientPaint: null,
    requiresLineMetrics: false,
  };
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

/** True iff at least one itinerary route layer is currently mounted. */
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
 * Insert or update an itinerary's route layer. If the source already
 * exists its data is patched in place (no flicker); otherwise a fresh
 * source + glow + line triplet is created.
 *
 * Paint properties (color, opacity, visibility) are always reapplied so
 * a single call is enough to sync the layer with the latest store state.
 */
export function upsertRouteLayer(
  map: MapboxMap,
  itineraryId: string,
  points: RouteLayerPoint[],
  opts: RouteLayerOptions,
): void {
  const { source: srcId, glow: glowId, line: lineId } = ids(itineraryId);
  const visibility = opts.visible ? 'visible' : 'none';
  const opacity = Math.max(0, Math.min(1, opts.opacity01));
  const traceWidthPx = normalizeTraceWidthPx(opts.traceWidthPx);
  const borderWidthPx = traceBorderWidthPx(traceWidthPx);
  const renderSpec = buildRouteGeoJson(points, opts);
  const lineMetricsRegistry = getRouteLineMetricsRegistry(map);

  let existing = map.getSource(srcId) as GeoJSONSource | undefined;
  const mountedRequiresLineMetrics = lineMetricsRegistry.get(itineraryId)
    ?? inferMountedRouteUsesLineGradient(map, lineId);

  if (existing && mountedRequiresLineMetrics != null && mountedRequiresLineMetrics !== renderSpec.requiresLineMetrics) {
    try {
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
    // Defensive: drop any legacy glow layer left over from older builds so
    // the map never drapes a second, fully-transparent line over terrain.
    try {
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
    map.addLayer({
      id: lineId,
      type: 'line',
      source: srcId,
      slot: 'top',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        'line-elevation-reference': 'ground' as unknown as undefined,
        'line-z-offset': 3 as unknown as undefined,
        visibility,
      },
      paint: {
        'line-color': renderSpec.lineColorPaint as never,
        'line-width': traceWidthPx,
        'line-opacity': opacity,
        'line-emissive-strength': 1,
        'line-occlusion-opacity': 0,
        ...(renderSpec.lineGradientPaint ? { 'line-gradient': renderSpec.lineGradientPaint as never } : {}),
        ...(borderWidthPx > 0
          ? {
              'line-border-width': borderWidthPx,
              'line-border-color': 'rgba(255,255,255,0)',
            }
          : {}),
      },
    });
    lineMetricsRegistry.set(itineraryId, renderSpec.requiresLineMetrics);
  }

  // Always reapply paint / layout â€” cheap, ensures the layer reflects
  // the current store state regardless of the upsert path taken above.
  try {
    if (map.getLayer(lineId)) {
      map.setPaintProperty(lineId, 'line-color', renderSpec.lineColorPaint as never);
      if (renderSpec.lineGradientPaint) {
        map.setPaintProperty(lineId, 'line-gradient', renderSpec.lineGradientPaint as never);
      } else if (map.getPaintProperty(lineId, 'line-gradient') != null) {
        map.setPaintProperty(lineId, 'line-gradient', null as never);
      }
      setPaintPropertyIfChanged(map, lineId, 'line-width', traceWidthPx);
      setPaintPropertyIfChanged(map, lineId, 'line-opacity', opacity);
      setPaintPropertyIfChanged(map, lineId, 'line-border-width', borderWidthPx);
      setLayoutPropertyIfChanged(map, lineId, 'visibility', visibility);
    }
    lineMetricsRegistry.set(itineraryId, renderSpec.requiresLineMetrics);
    raiseRouteLayer(map, itineraryId);
    // Keep endpoint markers (if any) on top of the route lines.
    if (map.getLayer(ENDPOINT_HANDLE_HIT_LAYER_ID)) map.moveLayer(ENDPOINT_HANDLE_HIT_LAYER_ID);
    if (map.getLayer(ENDPOINT_LAYER_ID)) map.moveLayer(ENDPOINT_LAYER_ID);
  } catch {
    /* map may be tearing down */
  }
}

export function raiseRouteLayer(map: MapboxMap, itineraryId: string): void {
  const { line: lineId } = ids(itineraryId);
  try {
    if (!hasRasterLayerAbove(map, lineId)) return;
    if (map.getLayer(lineId)) map.moveLayer(lineId);
  } catch {
    /* map may be tearing down */
  }
}

export function removeRouteLayer(map: MapboxMap, itineraryId: string): void {
  const { source: srcId, glow: glowId, line: lineId } = ids(itineraryId);
  try {
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
  const { glow: glowId, line: lineId } = ids(itineraryId);
  const visibility = visible ? 'visible' : 'none';
  try {
    if (map.getLayer(glowId)) map.setLayoutProperty(glowId, 'visibility', visibility);
    if (map.getLayer(lineId)) map.setLayoutProperty(lineId, 'visibility', visibility);
  } catch {
    /* noop */
  }
}

/**
 * Strip every itinerary route layer from the map (used at unmount and
 * after a style.load before re-adding the surviving routes).
 */
export function removeAllRouteLayers(map: MapboxMap): void {
  try {
    const style = map.getStyle();
    if (!style?.sources) return;
    routeLineMetricsState.get(map)?.clear();
    for (const key of Object.keys(style.sources)) {
      if (!key.startsWith(SOURCE_PREFIX)) continue;
      const safe = key.slice(SOURCE_PREFIX.length);
      const glowId = `${GLOW_PREFIX}${safe}`;
      const lineId = `${LINE_PREFIX}${safe}`;
      try {
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

/** List the sanitised ids of every route layer currently on the map. */
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

/* ------------------------------------------------------------------ */
/* Endpoints (single global layer â€” follows the active itinerary)      */
/* ------------------------------------------------------------------ */

export function setRouteEndpoints(
  map: MapboxMap,
  endpoints: RouteEndpoint[],
): void {
  if (!canMutateStyle(map)) return;

  const features = endpoints.map((p) => ({
    type: 'Feature' as const,
    properties: { kind: p.kind, label: p.label ?? '', anchorId: p.id ?? '' },
    geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
  }));
  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features,
  };

  const existing = map.getSource(START_SOURCE_ID) as GeoJSONSource | undefined;

  if (existing) {
    try {
      existing.setData(geojson);
    } catch {
      /* noop */
    }
  } else {
    map.addSource(START_SOURCE_ID, { type: 'geojson', data: geojson });
    // Invisible, generously sized circle underneath the visible handle so the
    // drag interaction has a comfortable hit target on touch + mouse.
    map.addLayer({
      id: ENDPOINT_HANDLE_HIT_LAYER_ID,
      type: 'circle',
      source: START_SOURCE_ID,
      slot: 'top',
      paint: {
        'circle-radius': 16,
        'circle-color': '#000000',
        'circle-opacity': 0,
      },
    });
    map.addLayer({
      id: ENDPOINT_LAYER_ID,
      type: 'circle',
      source: START_SOURCE_ID,
      slot: 'top',
      paint: {
        'circle-radius': [
          'match',
          ['get', 'kind'],
          'waypoint',
          6,
          7,
        ],
        'circle-color': [
          'match',
          ['get', 'kind'],
          'start',
          '#34a853',
          'waypoint',
          '#ff8a3d',
          'end',
          '#c50000',
          '#ffffff',
        ],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
        'circle-emissive-strength': 1,
      },
    });
  }

  try {
    if (map.getLayer(ENDPOINT_HANDLE_HIT_LAYER_ID)) map.moveLayer(ENDPOINT_HANDLE_HIT_LAYER_ID);
    if (map.getLayer(ENDPOINT_LAYER_ID)) map.moveLayer(ENDPOINT_LAYER_ID);
  } catch {
    /* noop */
  }
}

export function setRouteAuditFindings(
  map: MapboxMap,
  findings: Array<{ id: string; coordinates: [number, number][]; title: string; detail: string }>,
  visible: boolean,
): void {
  if (!canMutateStyle(map)) return;

  const source = ensureRouteAuditLayers(map);
  if (!source) return;

  try {
    source.setData(buildRouteAuditGeoJson(findings));
    const visibility = visible && findings.length > 0 ? 'visible' : 'none';
    if (map.getLayer(ROUTE_AUDIT_GLOW_LAYER_ID)) {
      map.setLayoutProperty(ROUTE_AUDIT_GLOW_LAYER_ID, 'visibility', visibility);
    }
    if (map.getLayer(ROUTE_AUDIT_LINE_LAYER_ID)) {
      map.setLayoutProperty(ROUTE_AUDIT_LINE_LAYER_ID, 'visibility', visibility);
    }
  } catch {
    /* noop */
  }
}

export function clearRouteAuditFindings(map: MapboxMap): void {
  if (!canMutateStyle(map)) return;

  try {
    const source = ensureRouteAuditLayers(map);
    source?.setData(buildRouteAuditGeoJson(null));
    if (map.getLayer(ROUTE_AUDIT_GLOW_LAYER_ID)) {
      map.setLayoutProperty(ROUTE_AUDIT_GLOW_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(ROUTE_AUDIT_LINE_LAYER_ID)) {
      map.setLayoutProperty(ROUTE_AUDIT_LINE_LAYER_ID, 'visibility', 'none');
    }
  } catch {
    /* noop */
  }
}

export function setForbiddenZones(
  map: MapboxMap,
  zones: Array<{ id: string; points: Array<{ lon: number; lat: number }> }>,
): void {
  if (!canMutateStyle(map)) return;

  try {
    const source = ensureForbiddenZoneLayers(map);
    if (!source) return;
    source.setData(buildForbiddenZoneGeoJson(zones));
    const visibility = zones.length > 0 ? 'visible' : 'none';
    if (map.getLayer(FORBIDDEN_ZONE_FILL_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_FILL_LAYER_ID, 'visibility', visibility);
      map.moveLayer(FORBIDDEN_ZONE_FILL_LAYER_ID);
    }
    if (map.getLayer(FORBIDDEN_ZONE_LINE_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_LINE_LAYER_ID, 'visibility', visibility);
      map.moveLayer(FORBIDDEN_ZONE_LINE_LAYER_ID);
    }
  } catch {
    /* noop */
  }
}

export function clearForbiddenZones(map: MapboxMap): void {
  if (!canMutateStyle(map)) return;

  try {
    const source = ensureForbiddenZoneLayers(map);
    source?.setData(buildForbiddenZoneGeoJson(null));
    if (map.getLayer(FORBIDDEN_ZONE_FILL_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_FILL_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(FORBIDDEN_ZONE_LINE_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_LINE_LAYER_ID, 'visibility', 'none');
    }
  } catch {
    /* noop */
  }
}

export function setForbiddenZoneDraft(
  map: MapboxMap,
  points: Array<{ lon: number; lat: number }>,
): void {
  if (!canMutateStyle(map)) return;

  try {
    const source = ensureForbiddenZoneDraftLayers(map);
    if (!source) return;
    source.setData(buildForbiddenZoneDraftGeoJson(points));
    const fillVisibility = points.length >= 3 ? 'visible' : 'none';
    const lineVisibility = points.length >= 2 ? 'visible' : 'none';
    const vertexVisibility = points.length >= 1 ? 'visible' : 'none';
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID, 'visibility', fillVisibility);
      map.moveLayer(FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID);
    }
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID, 'visibility', lineVisibility);
      map.moveLayer(FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID);
    }
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID, 'visibility', vertexVisibility);
      map.moveLayer(FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID);
    }
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID, 'visibility', vertexVisibility);
      map.moveLayer(FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID);
    }
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID, 'visibility', vertexVisibility);
      map.moveLayer(FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID);
    }
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID, 'visibility', lineVisibility);
      map.moveLayer(FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID);
    }
  } catch {
    /* noop */
  }
}

export function clearForbiddenZoneDraft(map: MapboxMap): void {
  try {
    const source = ensureForbiddenZoneDraftLayers(map);
    source?.setData(buildForbiddenZoneDraftGeoJson(null));
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID)) {
      map.setLayoutProperty(FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID, 'visibility', 'none');
    }
  } catch {
    /* noop */
  }
}

export function clearRouteEndpoints(map: MapboxMap): void {
  try {
    if (map.getLayer(ENDPOINT_LAYER_ID)) map.removeLayer(ENDPOINT_LAYER_ID);
    if (map.getLayer(ENDPOINT_HANDLE_HIT_LAYER_ID)) map.removeLayer(ENDPOINT_HANDLE_HIT_LAYER_ID);
    if (map.getSource(START_SOURCE_ID)) map.removeSource(START_SOURCE_ID);
  } catch {
    /* noop */
  }
}

/**
 * Live dashed rubber-band drawn while a waypoint handle is being dragged.
 * `coords` is the polyline prev -> cursor -> next (2 or 3 points); pass null to clear.
 */
export function setWaypointDragConnector(
  map: MapboxMap,
  coords: Array<[number, number]> | null,
): void {
  if (!canMutateStyle(map)) return;
  if (!coords || coords.length < 2) {
    clearWaypointDragConnector(map);
    return;
  }

  const data: GeoJSON.Feature<GeoJSON.LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coords },
  };

  const existing = map.getSource(WAYPOINT_DRAG_CONNECTOR_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) {
    try {
      existing.setData(data);
    } catch {
      /* noop */
    }
  } else {
    map.addSource(WAYPOINT_DRAG_CONNECTOR_SOURCE_ID, { type: 'geojson', data });
    map.addLayer({
      id: WAYPOINT_DRAG_CONNECTOR_LAYER_ID,
      type: 'line',
      source: WAYPOINT_DRAG_CONNECTOR_SOURCE_ID,
      slot: 'top',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ff8a3d',
        'line-width': 2.5,
        'line-dasharray': [1.6, 1.4],
        'line-opacity': 0.95,
        'line-emissive-strength': 1,
      },
    });
  }

  try {
    if (map.getLayer(WAYPOINT_DRAG_CONNECTOR_LAYER_ID)) map.moveLayer(WAYPOINT_DRAG_CONNECTOR_LAYER_ID);
    // Keep the handles above the connector line.
    if (map.getLayer(ENDPOINT_HANDLE_HIT_LAYER_ID)) map.moveLayer(ENDPOINT_HANDLE_HIT_LAYER_ID);
    if (map.getLayer(ENDPOINT_LAYER_ID)) map.moveLayer(ENDPOINT_LAYER_ID);
  } catch {
    /* noop */
  }
}

export function clearWaypointDragConnector(map: MapboxMap): void {
  try {
    if (map.getLayer(WAYPOINT_DRAG_CONNECTOR_LAYER_ID)) map.removeLayer(WAYPOINT_DRAG_CONNECTOR_LAYER_ID);
    if (map.getSource(WAYPOINT_DRAG_CONNECTOR_SOURCE_ID)) map.removeSource(WAYPOINT_DRAG_CONNECTOR_SOURCE_ID);
  } catch {
    /* noop */
  }
}

export function setAnalysisHoverPoint(
  map: MapboxMap,
  point: { lon: number; lat: number; color?: string },
): void {
  try {
    const source = ensureAnalysisHoverLayers(map);
    if (!source) return;
    source.setData(buildAnalysisHoverGeoJson(point));
    if (!analysisHoverVisibilityState.get(map)) {
      if (map.getLayer(ANALYSIS_HOVER_HALO_LAYER_ID)) {
        map.setLayoutProperty(ANALYSIS_HOVER_HALO_LAYER_ID, 'visibility', 'visible');
        map.moveLayer(ANALYSIS_HOVER_HALO_LAYER_ID);
      }
      if (map.getLayer(ANALYSIS_HOVER_POINT_LAYER_ID)) {
        map.setLayoutProperty(ANALYSIS_HOVER_POINT_LAYER_ID, 'visibility', 'visible');
        map.moveLayer(ANALYSIS_HOVER_POINT_LAYER_ID);
      }
      analysisHoverVisibilityState.set(map, true);
    }
  } catch {
    /* noop */
  }
}

export function clearAnalysisHoverPoint(map: MapboxMap): void {
  try {
    const source = map.getSource(ANALYSIS_HOVER_SOURCE_ID) as GeoJSONSource | undefined;
    if (!analysisHoverVisibilityState.get(map)) return;
    source?.setData(buildAnalysisHoverGeoJson(null));
    if (map.getLayer(ANALYSIS_HOVER_HALO_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_HOVER_HALO_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(ANALYSIS_HOVER_POINT_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_HOVER_POINT_LAYER_ID, 'visibility', 'none');
    }
    analysisHoverVisibilityState.set(map, false);
  } catch {
    /* noop */
  }
}

export function setAnalysisFlyoverProgress(
  map: MapboxMap,
  coordinates: [number, number][],
  color?: string,
): void {
  try {
    const source = ensureAnalysisFlyoverProgressLayers(map);
    if (!source) return;
    source.setData(buildAnalysisFlyoverProgressGeoJson(coordinates, color));
    if (map.getLayer(ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID, 'visibility', 'visible');
      map.moveLayer(ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID, 'visibility', 'visible');
      map.moveLayer(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_HOVER_HALO_LAYER_ID)) map.moveLayer(ANALYSIS_HOVER_HALO_LAYER_ID);
    if (map.getLayer(ANALYSIS_HOVER_POINT_LAYER_ID)) map.moveLayer(ANALYSIS_HOVER_POINT_LAYER_ID);
  } catch {
    /* noop */
  }
}

export function clearAnalysisFlyoverProgress(map: MapboxMap): void {
  try {
    const source = map.getSource(ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(buildAnalysisFlyoverProgressGeoJson(null));
    if (map.getLayer(ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID, 'visibility', 'none');
    }
  } catch {
    /* noop */
  }
}

export function fitToRoute(
  map: MapboxMap,
  coordinates: [number, number][],
): void {
  if (coordinates.length === 0) return;
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const [lon, lat] of coordinates) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const bounds: LngLatBoundsLike = [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
  map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 800 });
}
