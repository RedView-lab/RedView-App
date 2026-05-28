/**
 * Mapbox layer helpers for the BRouter-computed routes.
 *
 * Each itinerary owns its own source + glow + line layer triplet, keyed
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

export {
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
  label?: string;
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
  /** Line opacity 0..1. The glow layer is scaled to 40 % of this. */
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

const ROUTE_SLOPE_TARGET_SEGMENT_M = 15;
const ROUTE_MIN_SEGMENT_DISTANCE_M = 0.5;

function normalizeTraceWidthPx(value: number | null | undefined): number {
  return Math.max(1, Math.min(12, Math.round(value ?? 4)));
}

function traceGlowWidthPx(traceWidthPx: number): number {
  return Math.max(traceWidthPx + 6, traceWidthPx * 2.2);
}

function traceBorderWidthPx(traceWidthPx: number): number {
  return Math.max(1, Math.min(2, traceWidthPx * 0.25));
}

function clampSlopeDeg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(90, value));
}

function interpolateNumber(a: number, b: number, t: number): number {
  return a + ((b - a) * t);
}

function interpolateCoordinate(
  start: RouteLayerPoint,
  end: RouteLayerPoint,
  t: number,
): [number, number] {
  return [
    interpolateNumber(start.lon, end.lon, t),
    interpolateNumber(start.lat, end.lat, t),
  ];
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
    const riseM = Math.abs((end.elevationM as number) - (start.elevationM as number));
    return clampSlopeDeg((Math.atan(riseM / distanceM) * 180) / Math.PI);
  }

  const gradientCandidates = [start.gradientPct, end.gradientPct]
    .filter((value): value is number => Number.isFinite(value))
    .map((value) => Math.abs(value));

  if (gradientCandidates.length === 0) return 0;

  const avgGradientPct = gradientCandidates.reduce((sum, value) => sum + value, 0) / gradientCandidates.length;
  return clampSlopeDeg((Math.atan(avgGradientPct / 100) * 180) / Math.PI);
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

function buildSlopeRouteGeoJson(
  points: readonly RouteLayerPoint[],
  bands: ReadonlyArray<RouteSlopeBand>,
  fallbackColor: string,
): GeoJSON.Feature<GeoJSON.LineString> | GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentDistanceM = resolveSegmentDistanceM(start, end);
    if (!(segmentDistanceM > ROUTE_MIN_SEGMENT_DISTANCE_M)) continue;

    const segmentSlopeDeg = resolveSlopeDeg(start, end, segmentDistanceM);
    const segmentSlopePct = Math.tan((segmentSlopeDeg * Math.PI) / 180) * 100;
    const band = pickSlopeBand(bands, segmentSlopeDeg);
    const segmentColor = band?.color ?? fallbackColor;
    const subdivisionCount = Math.max(1, Math.ceil(segmentDistanceM / ROUTE_SLOPE_TARGET_SEGMENT_M));

    for (let partIndex = 0; partIndex < subdivisionCount; partIndex += 1) {
      const t0 = partIndex / subdivisionCount;
      const t1 = (partIndex + 1) / subdivisionCount;
      const coordinates = [
        interpolateCoordinate(start, end, t0),
        interpolateCoordinate(start, end, t1),
      ] as [number, number][];

      if (
        coordinates[0][0] === coordinates[1][0]
        && coordinates[0][1] === coordinates[1][1]
      ) {
        continue;
      }

      const lastFeature = features[features.length - 1];
      const lastCoordinates = lastFeature?.geometry.coordinates;
      const lastEndCoordinate = lastCoordinates?.[lastCoordinates.length - 1];
      if (
        lastFeature
        && lastFeature.properties?.bandId === (band?.id ?? 'fallback')
        && lastEndCoordinate
        && lastEndCoordinate[0] === coordinates[0][0]
        && lastEndCoordinate[1] === coordinates[0][1]
      ) {
        lastCoordinates.push(coordinates[1]);
        continue;
      }

      features.push({
        type: 'Feature',
        properties: {
          color: segmentColor,
          bandId: band?.id ?? 'fallback',
          slopeDeg: Math.round(segmentSlopeDeg * 10) / 10,
          slopePct: Math.round(segmentSlopePct),
        },
        geometry: {
          type: 'LineString',
          coordinates,
        },
      });
    }
  }

  if (features.length === 0) return buildDefaultRouteGeoJson(points);
  return {
    type: 'FeatureCollection',
    features,
  };
}

function buildRouteGeoJson(
  points: readonly RouteLayerPoint[],
  opts: RouteLayerOptions,
): GeoJSON.Feature<GeoJSON.LineString> | GeoJSON.FeatureCollection<GeoJSON.LineString> {
  if (opts.renderMode === 'slope') {
    return buildSlopeRouteGeoJson(points, opts.slopeBands ?? [], opts.color);
  }
  return buildDefaultRouteGeoJson(points);
}

function buildRouteLineColorPaint(opts: RouteLayerOptions): string | unknown[] {
  if (opts.renderMode === 'slope') {
    return ['coalesce', ['get', 'color'], opts.color];
  }
  return opts.color;
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
  const glowWidthPx = traceGlowWidthPx(traceWidthPx);
  const borderWidthPx = traceBorderWidthPx(traceWidthPx);
  const routeData = buildRouteGeoJson(points, opts);
  const lineColorPaint = buildRouteLineColorPaint(opts);

  const existing = map.getSource(srcId) as GeoJSONSource | undefined;

  if (existing) {
    try {
      existing.setData(routeData);
    } catch {
      /* noop */
    }
  } else {
    if (!canMutateStyle(map)) return;
    map.addSource(srcId, {
      type: 'geojson',
      lineMetrics: true,
      data: routeData,
    });
    map.addLayer({
      id: glowId,
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
        'line-color': lineColorPaint as never,
        'line-width': glowWidthPx,
        'line-opacity': 0.4 * opacity,
        'line-blur': 4,
        'line-emissive-strength': 1,
      },
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
        'line-color': lineColorPaint as never,
        'line-width': traceWidthPx,
        'line-opacity': opacity,
        'line-emissive-strength': 1,
        'line-border-width': borderWidthPx,
        'line-border-color': 'rgba(255,255,255,0.6)',
        'line-occlusion-opacity': 0,
      },
    });
  }

  // Always reapply paint / layout â€” cheap, ensures the layer reflects
  // the current store state regardless of the upsert path taken above.
  try {
    if (map.getLayer(glowId)) {
      map.setPaintProperty(glowId, 'line-color', lineColorPaint as never);
      setPaintPropertyIfChanged(map, glowId, 'line-width', glowWidthPx);
      setPaintPropertyIfChanged(map, glowId, 'line-opacity', 0.4 * opacity);
      setLayoutPropertyIfChanged(map, glowId, 'visibility', visibility);
    }
    if (map.getLayer(lineId)) {
      map.setPaintProperty(lineId, 'line-color', lineColorPaint as never);
      setPaintPropertyIfChanged(map, lineId, 'line-width', traceWidthPx);
      setPaintPropertyIfChanged(map, lineId, 'line-opacity', opacity);
      setPaintPropertyIfChanged(map, lineId, 'line-border-width', borderWidthPx);
      setLayoutPropertyIfChanged(map, lineId, 'visibility', visibility);
    }
    raiseRouteLayer(map, itineraryId);
    // Keep endpoint markers (if any) on top of the route lines.
    if (map.getLayer(ENDPOINT_LAYER_ID)) map.moveLayer(ENDPOINT_LAYER_ID);
  } catch {
    /* map may be tearing down */
  }
}

export function raiseRouteLayer(map: MapboxMap, itineraryId: string): void {
  const { glow: glowId, line: lineId } = ids(itineraryId);
  try {
    if (!hasRasterLayerAbove(map, glowId) && !hasRasterLayerAbove(map, lineId)) return;
    if (map.getLayer(glowId)) map.moveLayer(glowId);
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
    properties: { kind: p.kind, label: p.label ?? '' },
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
    if (map.getSource(START_SOURCE_ID)) map.removeSource(START_SOURCE_ID);
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
    if (map.getLayer(ANALYSIS_HOVER_HALO_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_HOVER_HALO_LAYER_ID, 'visibility', 'visible');
      map.moveLayer(ANALYSIS_HOVER_HALO_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_HOVER_POINT_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_HOVER_POINT_LAYER_ID, 'visibility', 'visible');
      map.moveLayer(ANALYSIS_HOVER_POINT_LAYER_ID);
    }
  } catch {
    /* noop */
  }
}

export function clearAnalysisHoverPoint(map: MapboxMap): void {
  try {
    const source = map.getSource(ANALYSIS_HOVER_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(buildAnalysisHoverGeoJson(null));
    if (map.getLayer(ANALYSIS_HOVER_HALO_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_HOVER_HALO_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(ANALYSIS_HOVER_POINT_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_HOVER_POINT_LAYER_ID, 'visibility', 'none');
    }
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
