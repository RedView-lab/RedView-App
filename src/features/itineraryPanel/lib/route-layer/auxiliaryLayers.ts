import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl';

import {
  ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID,
  ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID,
  ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID,
  ANALYSIS_HOVER_POINT_LAYER_ID,
  ANALYSIS_HOVER_SOURCE_ID,
  ANALYSIS_SELECTION_LINE_LAYER_ID,
  ANALYSIS_SELECTION_SOURCE_ID,
  FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_SOURCE_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID,
  FORBIDDEN_ZONE_FILL_LAYER_ID,
  FORBIDDEN_ZONE_LINE_LAYER_ID,
  FORBIDDEN_ZONE_SOURCE_ID,
  ROUTE_AUDIT_GLOW_LAYER_ID,
  ROUTE_AUDIT_LINE_LAYER_ID,
  ROUTE_AUDIT_SOURCE_ID,
  ROUTE_HOVER_PREVIEW_HALO_LAYER_ID,
  ROUTE_HOVER_PREVIEW_POINT_LAYER_ID,
  ROUTE_HOVER_PREVIEW_SOURCE_ID,
  canMutateStyle,
} from './constants';
import {
  buildAnalysisFlyoverProgressGeoJson,
  buildAnalysisHoverGeoJson,
  buildAnalysisSelectionGeoJson,
  buildForbiddenZoneDraftGeoJson,
  buildForbiddenZoneGeoJson,
  buildRouteAuditGeoJson,
  buildRouteHoverPreviewGeoJson,
} from './geojson';
import { getMountedSourceRequiresLineMetrics } from './itineraryLayers';

export function ensureAnalysisHoverLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  const existing = map.getSource(ANALYSIS_HOVER_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) return existing;

  map.addSource(ANALYSIS_HOVER_SOURCE_ID, {
    type: 'geojson',
    data: buildAnalysisHoverGeoJson(null),
  });



  map.addLayer({
    id: ANALYSIS_HOVER_POINT_LAYER_ID,
    type: 'circle',
    source: ANALYSIS_HOVER_SOURCE_ID,
    slot: 'top',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 8,
      'circle-color': '#ffffff',
      'circle-stroke-width': 3,
      'circle-stroke-color': ['coalesce', ['get', 'color'], '#ff4d4f'],
      'circle-opacity': 1,
      'circle-stroke-opacity': 0.96,
      'circle-pitch-alignment': 'viewport',
      'circle-pitch-scale': 'viewport',
      'circle-emissive-strength': 1.2,
    },
  });

  return map.getSource(ANALYSIS_HOVER_SOURCE_ID) as GeoJSONSource | null;
}

export function ensureRouteHoverPreviewLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  const existing = map.getSource(ROUTE_HOVER_PREVIEW_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) {
    try {
      if (map.getLayer(ROUTE_HOVER_PREVIEW_POINT_LAYER_ID)) {
        map.setPaintProperty(ROUTE_HOVER_PREVIEW_POINT_LAYER_ID, 'circle-radius', ['coalesce', ['get', 'radius'], 6.5]);
        map.setPaintProperty(ROUTE_HOVER_PREVIEW_POINT_LAYER_ID, 'circle-stroke-width', 2.5);
      }
      if (map.getLayer(ROUTE_HOVER_PREVIEW_HALO_LAYER_ID)) {
        map.setPaintProperty(
          ROUTE_HOVER_PREVIEW_HALO_LAYER_ID,
          'circle-radius',
          ['case', ['get', 'dimmed'], 8, ['+', ['coalesce', ['get', 'radius'], 6.5], 3]],
        );
        map.setPaintProperty(ROUTE_HOVER_PREVIEW_HALO_LAYER_ID, 'circle-color', '#000000');
        map.setPaintProperty(
          ROUTE_HOVER_PREVIEW_HALO_LAYER_ID,
          'circle-opacity',
          ['case', ['get', 'dimmed'], 0.12, 0.28],
        );
      }
    } catch {
      /* noop */
    }
    return existing;
  }

  map.addSource(ROUTE_HOVER_PREVIEW_SOURCE_ID, {
    type: 'geojson',
    data: buildRouteHoverPreviewGeoJson(null),
  });

  map.addLayer({
    id: ROUTE_HOVER_PREVIEW_HALO_LAYER_ID,
    type: 'circle',
    source: ROUTE_HOVER_PREVIEW_SOURCE_ID,
    slot: 'top',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['case', ['get', 'dimmed'], 8, ['+', ['coalesce', ['get', 'radius'], 6.5], 3]],
      'circle-color': '#000000',
      'circle-opacity': ['case', ['get', 'dimmed'], 0.12, 0.28],
      'circle-blur': 0.6,
      'circle-pitch-alignment': 'viewport',
      'circle-pitch-scale': 'viewport',
      'circle-emissive-strength': 1,
    },
  });

  map.addLayer({
    id: ROUTE_HOVER_PREVIEW_POINT_LAYER_ID,
    type: 'circle',
    source: ROUTE_HOVER_PREVIEW_SOURCE_ID,
    slot: 'top',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['coalesce', ['get', 'radius'], 6.5],
      'circle-color': '#ffffff',
      'circle-stroke-width': 2.5,
      'circle-stroke-color': ['coalesce', ['get', 'color'], '#ff4d4f'],
      'circle-opacity': 1,
      'circle-stroke-opacity': ['case', ['get', 'dimmed'], 0.45, 1],
      'circle-pitch-alignment': 'viewport',
      'circle-pitch-scale': 'viewport',
      'circle-emissive-strength': 1.2,
    },
  });

  return map.getSource(ROUTE_HOVER_PREVIEW_SOURCE_ID) as GeoJSONSource | null;
}

export function ensureAnalysisFlyoverProgressLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  let existing = map.getSource(ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID) as GeoJSONSource | undefined;
  const mountedSourceRequiresLineMetrics = getMountedSourceRequiresLineMetrics(map, ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID);
  if (existing && mountedSourceRequiresLineMetrics !== true) {
    try {
      if (map.getLayer(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID)) {
        map.removeLayer(ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID);
      }
      if (map.getLayer(ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID)) {
        map.removeLayer(ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID);
      }
      map.removeSource(ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID);
    } catch {
      /* noop */
    }
    existing = undefined;
  }
  if (existing) return existing;

  map.addSource(ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID, {
    type: 'geojson',
    lineMetrics: true,
    data: buildAnalysisFlyoverProgressGeoJson(null),
  });

  map.addLayer({
    id: ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID,
    type: 'line',
    source: ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID,
    slot: 'top',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-elevation-reference': 'ground' as unknown as undefined,
      'line-z-offset': 0.8 as unknown as undefined,
      visibility: 'none',
    },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ff4d4f'],
      'line-width': 14,
      'line-opacity': 0.34,
      'line-blur': 3.2,
      'line-emissive-strength': 1.1,
      'line-occlusion-opacity': 0,
    },
  });

  map.addLayer({
    id: ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID,
    type: 'line',
    source: ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID,
    slot: 'top',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-elevation-reference': 'ground' as unknown as undefined,
      'line-z-offset': 0.8 as unknown as undefined,
      visibility: 'none',
    },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ff4d4f'],
      'line-width': 6,
      'line-opacity': 0.96,
      'line-emissive-strength': 1.18,
      'line-border-width': 1.6,
      'line-border-color': 'rgba(255,255,255,0.54)',
      'line-occlusion-opacity': 0,
    },
  });

  return map.getSource(ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID) as GeoJSONSource | null;
}

export function ensureAnalysisSelectionLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  let existing = map.getSource(ANALYSIS_SELECTION_SOURCE_ID) as GeoJSONSource | undefined;
  const mountedSourceRequiresLineMetrics = getMountedSourceRequiresLineMetrics(map, ANALYSIS_SELECTION_SOURCE_ID);
  if (existing && mountedSourceRequiresLineMetrics !== true) {
    try {
      if (map.getLayer(ANALYSIS_SELECTION_LINE_LAYER_ID)) {
        map.removeLayer(ANALYSIS_SELECTION_LINE_LAYER_ID);
      }
      map.removeSource(ANALYSIS_SELECTION_SOURCE_ID);
    } catch {
      /* noop */
    }
    existing = undefined;
  }
  if (existing) return existing;

  map.addSource(ANALYSIS_SELECTION_SOURCE_ID, {
    type: 'geojson',
    lineMetrics: true,
    data: buildAnalysisSelectionGeoJson(null),
  });

  map.addLayer({
    id: ANALYSIS_SELECTION_LINE_LAYER_ID,
    type: 'line',
    source: ANALYSIS_SELECTION_SOURCE_ID,
    slot: 'top',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-elevation-reference': 'ground' as unknown as undefined,
      'line-z-offset': 0.86 as unknown as undefined,
      visibility: 'none',
    },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ffffff'],
      'line-width': 4.5,
      'line-opacity': 1,
      'line-border-width': 1.5,
      'line-border-color': 'rgba(0, 0, 0, 0.45)',
      'line-occlusion-opacity': 0,
      'line-emissive-strength': 1.1,
    },
  });

  return map.getSource(ANALYSIS_SELECTION_SOURCE_ID) as GeoJSONSource | null;
}

export function ensureRouteAuditLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  const existing = map.getSource(ROUTE_AUDIT_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) return existing;

  map.addSource(ROUTE_AUDIT_SOURCE_ID, {
    type: 'geojson',
    data: buildRouteAuditGeoJson(null),
  });

  map.addLayer({
    id: ROUTE_AUDIT_GLOW_LAYER_ID,
    type: 'line',
    source: ROUTE_AUDIT_SOURCE_ID,
    slot: 'top',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-elevation-reference': 'ground' as unknown as undefined,
      'line-z-offset': 5 as unknown as undefined,
      visibility: 'none',
    },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ff3b30'],
      'line-width': 18,
      'line-opacity': 0.34,
      'line-blur': 4,
      'line-emissive-strength': 1.12,
      'line-occlusion-opacity': 0,
    },
  });

  map.addLayer({
    id: ROUTE_AUDIT_LINE_LAYER_ID,
    type: 'line',
    source: ROUTE_AUDIT_SOURCE_ID,
    slot: 'top',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-elevation-reference': 'ground' as unknown as undefined,
      'line-z-offset': 5 as unknown as undefined,
      visibility: 'none',
    },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ff3b30'],
      'line-width': 7,
      'line-opacity': 0.96,
      'line-emissive-strength': 1.18,
      'line-border-width': 1.6,
      'line-border-color': 'rgba(255,255,255,0.56)',
      'line-occlusion-opacity': 0,
    },
  });

  return map.getSource(ROUTE_AUDIT_SOURCE_ID) as GeoJSONSource | null;
}

export function ensureForbiddenZoneLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  const existing = map.getSource(FORBIDDEN_ZONE_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) return existing;

  map.addSource(FORBIDDEN_ZONE_SOURCE_ID, {
    type: 'geojson',
    data: buildForbiddenZoneGeoJson(null),
  });

  map.addLayer({
    id: FORBIDDEN_ZONE_FILL_LAYER_ID,
    type: 'fill',
    source: FORBIDDEN_ZONE_SOURCE_ID,
    slot: 'top',
    layout: { visibility: 'none' },
    paint: {
      'fill-color': ['coalesce', ['get', 'fillColor'], '#ff3b30'],
      'fill-opacity': 0.2,
      'fill-emissive-strength': 0.8,
    },
  });

  map.addLayer({
    id: FORBIDDEN_ZONE_LINE_LAYER_ID,
    type: 'line',
    source: FORBIDDEN_ZONE_SOURCE_ID,
    slot: 'top',
    layout: { visibility: 'none' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ff3b30'],
      'line-width': 3,
      'line-opacity': 0.96,
      'line-emissive-strength': 1.1,
    },
  });

  return map.getSource(FORBIDDEN_ZONE_SOURCE_ID) as GeoJSONSource | null;
}

export function ensureForbiddenZoneDraftLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  const existing = map.getSource(FORBIDDEN_ZONE_DRAFT_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) return existing;

  map.addSource(FORBIDDEN_ZONE_DRAFT_SOURCE_ID, {
    type: 'geojson',
    data: buildForbiddenZoneDraftGeoJson(null),
  });

  map.addLayer({
    id: FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID,
    type: 'fill',
    source: FORBIDDEN_ZONE_DRAFT_SOURCE_ID,
    slot: 'top',
    filter: ['==', ['get', 'role'], 'shape'],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': ['coalesce', ['get', 'fillColor'], '#ff3b30'],
      'fill-opacity': 0.12,
      'fill-emissive-strength': 0.9,
    },
  });

  map.addLayer({
    id: FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID,
    type: 'line',
    source: FORBIDDEN_ZONE_DRAFT_SOURCE_ID,
    slot: 'top',
    filter: ['==', ['get', 'role'], 'shape'],
    layout: { visibility: 'none' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ff3b30'],
      'line-width': 3,
      'line-opacity': 0.88,
      'line-dasharray': [1, 1],
      'line-emissive-strength': 1,
    },
  });

  map.addLayer({
    id: FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID,
    type: 'circle',
    source: FORBIDDEN_ZONE_DRAFT_SOURCE_ID,
    slot: 'top',
    filter: ['==', ['get', 'role'], 'vertex'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 15,
      'circle-color': '#ffffff',
      'circle-opacity': 0.28,
      'circle-stroke-width': 0,
      'circle-emissive-strength': 1,
    },
  });

  map.addLayer({
    id: FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID,
    type: 'circle',
    source: FORBIDDEN_ZONE_DRAFT_SOURCE_ID,
    slot: 'top',
    filter: ['==', ['get', 'role'], 'vertex'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 7,
      'circle-color': ['coalesce', ['get', 'fillColor'], '#ffffff'],
      'circle-stroke-width': 3,
      'circle-stroke-color': ['coalesce', ['get', 'color'], '#ff3b30'],
      'circle-opacity': 1,
      'circle-stroke-opacity': 0.98,
      'circle-emissive-strength': 1.12,
    },
  });

  map.addLayer({
    id: FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID,
    type: 'circle',
    source: FORBIDDEN_ZONE_DRAFT_SOURCE_ID,
    slot: 'top',
    filter: ['==', ['get', 'role'], 'vertex'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 60,
      'circle-color': '#000000',
      'circle-opacity': 0.001,
      'circle-stroke-width': 0,
    },
  });

  map.addLayer({
    id: FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID,
    type: 'line',
    source: FORBIDDEN_ZONE_DRAFT_SOURCE_ID,
    slot: 'top',
    filter: ['==', ['get', 'role'], 'edge'],
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      visibility: 'none',
    },
    paint: {
      'line-width': 96,
      'line-color': '#000000',
      'line-opacity': 0.001,
    },
  });

  return map.getSource(FORBIDDEN_ZONE_DRAFT_SOURCE_ID) as GeoJSONSource | null;
}