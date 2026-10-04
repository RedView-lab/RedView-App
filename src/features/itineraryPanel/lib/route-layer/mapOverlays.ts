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
import { ROUTE_SELECTION_CLEARANCE_M, getRouteLineElevation } from './routeElevation';
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
    routeHoverPreviewVisibilityState.set(map, true);
  } catch {
    /* noop */
  }
}

export function clearRouteHoverPreview(map: MapboxMap): void {
  try {
    if (!routeHoverPreviewVisibilityState.get(map)) return;
    const source = map.getSource(ROUTE_HOVER_PREVIEW_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(buildRouteHoverPreviewGeoJson(null));
    routeHoverPreviewVisibilityState.set(map, false);
  } catch {
    /* noop */
  }
}

const FLYOVER_PROGRESS_LAYER_IDS = [
  ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID,
  ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID,
] as const;
const flyoverProgressState = new WeakMap<MapboxMap, number>();

/**
 * Flyover : pose la trace complète une seule fois par session, entièrement
 * masquée. L'avancement se règle ensuite avec `setAnalysisFlyoverProgress`
 * (`line-trim-offset`, un simple uniform GPU : ni `setData` ni re-tuilage
 * par frame). Renvoie `false` si le style ne peut pas encore être modifié.
 */
export function setAnalysisFlyoverRoute(
  map: MapboxMap,
  points: readonly RouteLayerPoint[],
  color?: string,
): boolean {
  try {
    const source = ensureAnalysisFlyoverProgressLayers(map);
    if (!source) return false;

    if (points.length < 2) {
      clearAnalysisFlyoverProgress(map);
      return false;
    }

    const coords = points.map((pt): [number, number] => [pt.lon, pt.lat]);
    const geoJson = buildAnalysisFlyoverProgressGeoJson(coords, color);
    const { reference: elevationReference, zOffset } = getRouteLineElevation(map, ROUTE_SELECTION_CLEARANCE_M);

    source.setData(geoJson);
    flyoverProgressState.delete(map);

    for (const layerId of FLYOVER_PROGRESS_LAYER_IDS) {
      if (!map.getLayer(layerId)) continue;
      setLayoutPropertyIfChanged(map, layerId, 'line-elevation-reference', elevationReference);
      setLayoutPropertyIfChanged(map, layerId, 'line-z-offset', zOffset);
      setPaintPropertyIfChanged(map, layerId, 'line-occlusion-opacity', 0);
      map.setPaintProperty(layerId, 'line-trim-offset', [0, 1]);
      setLayoutPropertyIfChanged(map, layerId, 'visibility', 'visible');
      map.moveLayer(layerId);
    }
    if (map.getLayer(ANALYSIS_HOVER_HALO_LAYER_ID)) map.moveLayer(ANALYSIS_HOVER_HALO_LAYER_ID);
    if (map.getLayer(ANALYSIS_HOVER_POINT_LAYER_ID)) map.moveLayer(ANALYSIS_HOVER_POINT_LAYER_ID);
    return true;
  } catch {
    return false;
  }
}

/**
 * Part déjà parcourue de la trace posée par `setAnalysisFlyoverRoute`, en
 * fraction de `line-progress` (longueur d'arc Mercator projetée). Appelé à
 * chaque frame : ne touche le style que si la valeur change.
 */
export function setAnalysisFlyoverProgress(map: MapboxMap, lineProgress: number): void {
  const fraction = Math.max(0, Math.min(1, lineProgress));
  if (flyoverProgressState.get(map) === fraction) return;
  flyoverProgressState.set(map, fraction);
  // [f, 1] masque la suite ; [1, 1] ne masque rien (trace complète).
  const trim: [number, number] = fraction >= 1 ? [1, 1] : [fraction, 1];
  try {
    for (const layerId of FLYOVER_PROGRESS_LAYER_IDS) {
      if (map.getLayer(layerId)) map.setPaintProperty(layerId, 'line-trim-offset', trim, { validate: false });
    }
  } catch {
    /* style en cours de remplacement */
  }
}

/** Vrai tant que la trace du flyover est montée et visible (sert au retour d'un changement de style). */
export function isAnalysisFlyoverRouteMounted(map: MapboxMap): boolean {
  try {
    return Boolean(map.getLayer(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID))
      && map.getLayoutProperty(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID, 'visibility') === 'visible';
  } catch {
    return false;
  }
}

export function clearAnalysisFlyoverProgress(map: MapboxMap): void {
  flyoverProgressState.delete(map);
  try {
    const source = map.getSource(ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(buildAnalysisFlyoverProgressGeoJson(null));
    for (const layerId of FLYOVER_PROGRESS_LAYER_IDS) {
      if (map.getLayer(layerId)) setLayoutPropertyIfChanged(map, layerId, 'visibility', 'none');
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

    const coords: [number, number][] = Array.isArray(segment[0])
      ? (segment as [number, number][])
      : (segment as RouteLayerPoint[]).map((pt) => [pt.lon, pt.lat]);

    const geoJson = buildAnalysisSelectionGeoJson(coords, color);
    const { reference: elevationReference, zOffset } = getRouteLineElevation(map, ROUTE_SELECTION_CLEARANCE_M);

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