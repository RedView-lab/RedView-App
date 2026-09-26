import type { GeoJSONSource, LngLatBoundsLike, Map as MapboxMap } from 'mapbox-gl';

import {
  ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID,
  ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID,
  ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID,
  ANALYSIS_HOVER_HALO_LAYER_ID,
  ANALYSIS_HOVER_POINT_LAYER_ID,
  ANALYSIS_HOVER_SOURCE_ID,
  ANALYSIS_SELECTION_LINE_LAYER_ID,
  ANALYSIS_SELECTION_SOURCE_ID,
  FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID,
  FORBIDDEN_ZONE_FILL_LAYER_ID,
  FORBIDDEN_ZONE_LINE_LAYER_ID,
  ROUTE_AUDIT_GLOW_LAYER_ID,
  ROUTE_AUDIT_LINE_LAYER_ID,
  ROUTE_HOVER_PREVIEW_HALO_LAYER_ID,
  ROUTE_HOVER_PREVIEW_POINT_LAYER_ID,
  ROUTE_HOVER_PREVIEW_SOURCE_ID,
  canMutateStyle,
} from './constants';
import {
  ensureAnalysisFlyoverProgressLayers,
  ensureAnalysisHoverLayers,
  ensureAnalysisSelectionLayers,
  ensureForbiddenZoneDraftLayers,
  ensureForbiddenZoneLayers,
  ensureRouteAuditLayers,
  ensureRouteHoverPreviewLayers,
} from './auxiliaryLayers';
import {
  buildAnalysisFlyoverProgressGeoJson,
  buildAnalysisHoverGeoJson,
  buildAnalysisSelectionGeoJson,
  buildForbiddenZoneDraftGeoJson,
  buildForbiddenZoneGeoJson,
  buildRouteAuditGeoJson,
  buildRouteHoverPreviewGeoJson,
  type RouteHoverPreviewPoint,
} from './geojson';
import type { RouteLayerPoint } from './routeStyle';
import {
  ROUTE_PROFILE_Z_OFFSET,
  ROUTE_SELECTION_CLEARANCE_M,
  applyRouteElevationProfile,
  getRouteElevationContext,
} from './routeElevation';
import { isValidElevation } from '../route-metrics/elevationSanitizer';
import { setLayoutPropertyIfChanged, setPaintPropertyIfChanged } from './itineraryLayers';

const analysisHoverVisibilityState = new WeakMap<MapboxMap, boolean>();
const routeHoverPreviewVisibilityState = new WeakMap<MapboxMap, boolean>();

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

export function setAnalysisHoverPoint(
  map: MapboxMap,
  point: { lon: number; lat: number; color?: string },
): void {
  try {
    const source = ensureAnalysisHoverLayers(map);
    if (!source) return;
    source.setData(buildAnalysisHoverGeoJson(point));
    if (!analysisHoverVisibilityState.get(map)) {
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
    if (map.getLayer(ANALYSIS_HOVER_POINT_LAYER_ID)) {
      map.setLayoutProperty(ANALYSIS_HOVER_POINT_LAYER_ID, 'visibility', 'none');
    }
    analysisHoverVisibilityState.set(map, false);
  } catch {
    /* noop */
  }
}

export function setRouteHoverPreview(map: MapboxMap, point: RouteHoverPreviewPoint): void {
  try {
    const source = ensureRouteHoverPreviewLayers(map);
    if (!source) return;
    source.setData(buildRouteHoverPreviewGeoJson(point));
    if (!routeHoverPreviewVisibilityState.get(map)) {
      if (map.getLayer(ROUTE_HOVER_PREVIEW_HALO_LAYER_ID)) {
        map.setLayoutProperty(ROUTE_HOVER_PREVIEW_HALO_LAYER_ID, 'visibility', 'visible');
        map.moveLayer(ROUTE_HOVER_PREVIEW_HALO_LAYER_ID);
      }
      if (map.getLayer(ROUTE_HOVER_PREVIEW_POINT_LAYER_ID)) {
        map.setLayoutProperty(ROUTE_HOVER_PREVIEW_POINT_LAYER_ID, 'visibility', 'visible');
        map.moveLayer(ROUTE_HOVER_PREVIEW_POINT_LAYER_ID);
      }
      routeHoverPreviewVisibilityState.set(map, true);
    }
  } catch {
    /* noop */
  }
}

export function clearRouteHoverPreview(map: MapboxMap): void {
  try {
    if (!routeHoverPreviewVisibilityState.get(map)) return;
    const source = map.getSource(ROUTE_HOVER_PREVIEW_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(buildRouteHoverPreviewGeoJson(null));
    if (map.getLayer(ROUTE_HOVER_PREVIEW_HALO_LAYER_ID)) {
      map.setLayoutProperty(ROUTE_HOVER_PREVIEW_HALO_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(ROUTE_HOVER_PREVIEW_POINT_LAYER_ID)) {
      map.setLayoutProperty(ROUTE_HOVER_PREVIEW_POINT_LAYER_ID, 'visibility', 'none');
    }
    routeHoverPreviewVisibilityState.set(map, false);
  } catch {
    /* noop */
  }
}

export function setAnalysisFlyoverProgress(
  map: MapboxMap,
  segment: RouteLayerPoint[] | [number, number][],
  color?: string,
): void {
  try {
    const source = ensureAnalysisFlyoverProgressLayers(map);
    if (!source) return;

    if (!segment || segment.length < 2) {
      clearAnalysisFlyoverProgress(map);
      return;
    }

    const isCoordinateArray = Array.isArray(segment[0]);
    const coords: [number, number][] = isCoordinateArray
      ? (segment as [number, number][])
      : (segment as RouteLayerPoint[]).map((pt) => [pt.lon, pt.lat]);
    const points: RouteLayerPoint[] = isCoordinateArray
      ? (segment as [number, number][]).map(([lon, lat]) => ({ lon, lat }))
      : (segment as RouteLayerPoint[]);

    const geoJson = buildAnalysisFlyoverProgressGeoJson(coords, color);
    const elevationContext = getRouteElevationContext(map);
    const elevationProfileApplied =
      elevationContext.scale !== null && points.some((pt) => isValidElevation(pt.elevationM))
        ? applyRouteElevationProfile(
            { data: geoJson, requiresLineMetrics: true },
            points,
            elevationContext.scale,
            ROUTE_SELECTION_CLEARANCE_M,
          )
        : false;

    const elevationReference = elevationProfileApplied
      ? 'sea'
      : elevationContext.scale !== null
        ? 'ground'
        : 'none';
    const zOffset = elevationProfileApplied
      ? ROUTE_PROFILE_Z_OFFSET
      : elevationContext.scale !== null
        ? 0.8
        : 0;

    source.setData(geoJson);

    if (map.getLayer(ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID)) {
      setLayoutPropertyIfChanged(map, ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID, 'line-elevation-reference', elevationReference);
      setLayoutPropertyIfChanged(map, ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID, 'line-z-offset', zOffset);
      setPaintPropertyIfChanged(map, ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID, 'line-occlusion-opacity', 0);
      setLayoutPropertyIfChanged(map, ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID, 'visibility', 'visible');
      map.moveLayer(ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID)) {
      setLayoutPropertyIfChanged(map, ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID, 'line-elevation-reference', elevationReference);
      setLayoutPropertyIfChanged(map, ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID, 'line-z-offset', zOffset);
      setPaintPropertyIfChanged(map, ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID, 'line-occlusion-opacity', 0);
      setLayoutPropertyIfChanged(map, ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID, 'visibility', 'visible');
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
      setLayoutPropertyIfChanged(map, ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID, 'visibility', 'none');
    }
    if (map.getLayer(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID)) {
      setLayoutPropertyIfChanged(map, ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID, 'visibility', 'none');
    }
  } catch {
    /* noop */
  }
}

export function setAnalysisSelectedSegment(
  map: MapboxMap,
  segment: RouteLayerPoint[] | [number, number][],
  color?: string,
): void {
  try {
    const source = ensureAnalysisSelectionLayers(map);
    if (!source) return;

    if (!segment || segment.length < 2) {
      clearAnalysisSelectedSegment(map);
      return;
    }

    const isCoordinateArray = Array.isArray(segment[0]);
    const coords: [number, number][] = isCoordinateArray
      ? (segment as [number, number][])
      : (segment as RouteLayerPoint[]).map((pt) => [pt.lon, pt.lat]);
    const points: RouteLayerPoint[] = isCoordinateArray
      ? (segment as [number, number][]).map(([lon, lat]) => ({ lon, lat }))
      : (segment as RouteLayerPoint[]);

    const geoJson = buildAnalysisSelectionGeoJson(coords, color);
    const elevationContext = getRouteElevationContext(map);
    const elevationProfileApplied =
      elevationContext.scale !== null && points.some((pt) => isValidElevation(pt.elevationM))
        ? applyRouteElevationProfile(
            { data: geoJson, requiresLineMetrics: true },
            points,
            elevationContext.scale,
            ROUTE_SELECTION_CLEARANCE_M,
          )
        : false;

    const elevationReference = elevationProfileApplied
      ? 'sea'
      : elevationContext.scale !== null
        ? 'ground'
        : 'none';
    const zOffset = elevationProfileApplied
      ? ROUTE_PROFILE_Z_OFFSET
      : elevationContext.scale !== null
        ? 0.8
        : 0;

    source.setData(geoJson);

    if (map.getLayer(ANALYSIS_SELECTION_LINE_LAYER_ID)) {
      setLayoutPropertyIfChanged(map, ANALYSIS_SELECTION_LINE_LAYER_ID, 'line-elevation-reference', elevationReference);
      setLayoutPropertyIfChanged(map, ANALYSIS_SELECTION_LINE_LAYER_ID, 'line-z-offset', zOffset);
      setPaintPropertyIfChanged(map, ANALYSIS_SELECTION_LINE_LAYER_ID, 'line-occlusion-opacity', 0);
      setLayoutPropertyIfChanged(map, ANALYSIS_SELECTION_LINE_LAYER_ID, 'visibility', 'visible');
      map.moveLayer(ANALYSIS_SELECTION_LINE_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_HOVER_HALO_LAYER_ID)) map.moveLayer(ANALYSIS_HOVER_HALO_LAYER_ID);
    if (map.getLayer(ANALYSIS_HOVER_POINT_LAYER_ID)) map.moveLayer(ANALYSIS_HOVER_POINT_LAYER_ID);
  } catch {
    /* noop */
  }
}

export function clearAnalysisSelectedSegment(map: MapboxMap): void {
  try {
    const source = map.getSource(ANALYSIS_SELECTION_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(buildAnalysisSelectionGeoJson(null));
    if (map.getLayer(ANALYSIS_SELECTION_LINE_LAYER_ID)) {
      setLayoutPropertyIfChanged(map, ANALYSIS_SELECTION_LINE_LAYER_ID, 'visibility', 'none');
    }
  } catch {
    /* noop */
  }
}

export interface FitToRouteOptions {
  padding?: number | { top: number; bottom: number; left: number; right: number };
  maxZoom?: number;
  duration?: number;
}

export function fitToRoute(
  map: MapboxMap,
  coordinates: [number, number][],
  options?: FitToRouteOptions,
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
  map.fitBounds(bounds, {
    padding: options?.padding ?? 80,
    maxZoom: options?.maxZoom ?? 14,
    duration: options?.duration ?? 800,
  });
}