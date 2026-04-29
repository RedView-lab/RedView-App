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

const SOURCE_PREFIX = 'brouter-route-source-';
const GLOW_PREFIX = 'brouter-route-glow-';
const LINE_PREFIX = 'brouter-route-line-';

const START_SOURCE_ID = 'brouter-endpoints-source';
const ENDPOINT_LAYER_ID = 'brouter-endpoints-layer';
const ANALYSIS_HOVER_SOURCE_ID = 'brouter-analysis-hover-source';
const ANALYSIS_HOVER_HALO_LAYER_ID = 'brouter-analysis-hover-halo-layer';
const ANALYSIS_HOVER_POINT_LAYER_ID = 'brouter-analysis-hover-point-layer';
const ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID = 'brouter-analysis-flyover-progress-source';
const ANALYSIS_FLYOVER_PROGRESS_GLOW_LAYER_ID = 'brouter-analysis-flyover-progress-glow-layer';
const ANALYSIS_FLYOVER_PROGRESS_LINE_LAYER_ID = 'brouter-analysis-flyover-progress-line-layer';
const ROUTE_AUDIT_SOURCE_ID = 'brouter-route-audit-source';
const ROUTE_AUDIT_GLOW_LAYER_ID = 'brouter-route-audit-glow-layer';
const ROUTE_AUDIT_LINE_LAYER_ID = 'brouter-route-audit-line-layer';
const FORBIDDEN_ZONE_SOURCE_ID = 'brouter-forbidden-zone-source';
const FORBIDDEN_ZONE_FILL_LAYER_ID = 'brouter-forbidden-zone-fill-layer';
const FORBIDDEN_ZONE_LINE_LAYER_ID = 'brouter-forbidden-zone-line-layer';
const FORBIDDEN_ZONE_DRAFT_SOURCE_ID = 'brouter-forbidden-zone-draft-source';
const FORBIDDEN_ZONE_DRAFT_FILL_LAYER_ID = 'brouter-forbidden-zone-draft-fill-layer';
const FORBIDDEN_ZONE_DRAFT_LINE_LAYER_ID = 'brouter-forbidden-zone-draft-line-layer';
export const FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID = 'brouter-forbidden-zone-draft-vertex-halo-layer';
export const FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID = 'brouter-forbidden-zone-draft-vertex-layer';
export const FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID = 'brouter-forbidden-zone-draft-vertex-hit-layer';
export const FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID = 'brouter-forbidden-zone-draft-segment-hit-layer';

function canMutateStyle(map: MapboxMap): boolean {
  try {
    return map.isStyleLoaded() && Boolean(map.getStyle());
  } catch {
    return false;
  }
}

function sanitizeId(id: string): string {
  // Mapbox source/layer ids must be safe â€” strip anything weird.
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildAnalysisHoverGeoJson(
  point?: { lon: number; lat: number; color?: string } | null,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: point
      ? [
          {
            type: 'Feature',
            properties: { color: point.color ?? '#ffffff' },
            geometry: {
              type: 'Point',
              coordinates: [point.lon, point.lat],
            },
          },
        ]
      : [],
  };
}

function buildAnalysisFlyoverProgressGeoJson(
  coordinates?: [number, number][] | null,
  color?: string,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      coordinates && coordinates.length >= 2
        ? [
            {
              type: 'Feature',
              properties: { color: color ?? '#ff4d4f' },
              geometry: {
                type: 'LineString',
                coordinates,
              },
            },
          ]
        : [],
  };
}

function buildRouteAuditGeoJson(
  findings?: Array<{ id: string; coordinates: [number, number][]; title: string; detail: string }> | null,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      findings?.flatMap((finding) =>
        finding.coordinates.length >= 2
          ? [
              {
                type: 'Feature' as const,
                properties: {
                  id: finding.id,
                  color: '#ff3b30',
                  title: finding.title,
                  detail: finding.detail,
                },
                geometry: {
                  type: 'LineString' as const,
                  coordinates: finding.coordinates,
                },
              },
            ]
          : [],
      ) ?? [],
  };
}

function closePolygonRing(coordinates: [number, number][]): [number, number][] {
  if (coordinates.length === 0) return coordinates;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return coordinates;
  return [...coordinates, first];
}

function buildForbiddenZoneGeoJson(
  zones?: Array<{ id: string; points: Array<{ lon: number; lat: number }> }> | null,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      zones?.flatMap((zone) => {
        if (zone.points.length < 3) return [];
        return [
          {
            type: 'Feature' as const,
            properties: {
              id: zone.id,
              color: '#ff3b30',
              fillColor: '#ff3b30',
            },
            geometry: {
              type: 'Polygon' as const,
              coordinates: [closePolygonRing(zone.points.map((point) => [point.lon, point.lat]))],
            },
          },
        ];
      }) ?? [],
  };
}

function buildForbiddenZoneDraftGeoJson(
  points?: Array<{ lon: number; lat: number }> | null,
): GeoJSON.FeatureCollection {
  if (!points || points.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }

  const features: GeoJSON.Feature[] = points.map((point, index) => ({
    type: 'Feature',
    properties: {
      role: 'vertex',
      index,
      color: '#ff3b30',
      fillColor: '#ffffff',
    },
    geometry: {
      type: 'Point',
      coordinates: [point.lon, point.lat],
    },
  }));

  if (points.length >= 2) {
    const edgeCount = points.length >= 3 ? points.length : points.length - 1;
    for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
      const start = points[edgeIndex];
      const end = points[(edgeIndex + 1) % points.length];
      if (!start || !end) continue;
      features.push({
        type: 'Feature',
        properties: { role: 'edge', edgeIndex },
        geometry: {
          type: 'LineString',
          coordinates: [
            [start.lon, start.lat],
            [end.lon, end.lat],
          ],
        },
      });
    }
  }

  if (points.length >= 3) {
    features.unshift({
      type: 'Feature',
      properties: {
        role: 'shape',
        color: '#ff3b30',
        fillColor: '#ff3b30',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [closePolygonRing(points.map((point) => [point.lon, point.lat]))],
      },
    });
  } else if (points.length >= 2) {
    features.unshift({
      type: 'Feature',
      properties: {
        role: 'shape',
        color: '#ff3b30',
        fillColor: '#ff3b30',
      },
      geometry: {
        type: 'LineString',
        coordinates: points.map((point) => [point.lon, point.lat]),
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

function ensureAnalysisHoverLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  const existing = map.getSource(ANALYSIS_HOVER_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) return existing;

  map.addSource(ANALYSIS_HOVER_SOURCE_ID, {
    type: 'geojson',
    data: buildAnalysisHoverGeoJson(null),
  });

  map.addLayer({
    id: ANALYSIS_HOVER_HALO_LAYER_ID,
    type: 'circle',
    source: ANALYSIS_HOVER_SOURCE_ID,
    slot: 'top',
    layout: {
      visibility: 'none',
    },
    paint: {
      'circle-radius': 15,
      'circle-color': '#ffffff',
      'circle-opacity': 0.42,
      'circle-blur': 0.75,
      'circle-pitch-alignment': 'viewport',
      'circle-pitch-scale': 'viewport',
      'circle-emissive-strength': 1,
    },
  });

  map.addLayer({
    id: ANALYSIS_HOVER_POINT_LAYER_ID,
    type: 'circle',
    source: ANALYSIS_HOVER_SOURCE_ID,
    slot: 'top',
    layout: {
      visibility: 'none',
    },
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

function ensureAnalysisFlyoverProgressLayers(map: MapboxMap): GeoJSONSource | null {
  if (!canMutateStyle(map)) return null;
  const existing = map.getSource(ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) return existing;

  map.addSource(ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID, {
    type: 'geojson',
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
      'line-z-offset': 4 as unknown as undefined,
      visibility: 'none',
    },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ff4d4f'],
      'line-width': 14,
      'line-opacity': 0.34,
      'line-blur': 3.2,
      'line-emissive-strength': 1.1,
      'line-occlusion-opacity': 0.88,
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
      'line-z-offset': 4 as unknown as undefined,
      visibility: 'none',
    },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ff4d4f'],
      'line-width': 6,
      'line-opacity': 0.96,
      'line-emissive-strength': 1.18,
      'line-border-width': 1.6,
      'line-border-color': 'rgba(255,255,255,0.54)',
      'line-occlusion-opacity': 0.92,
    },
  });

  return map.getSource(ANALYSIS_FLYOVER_PROGRESS_SOURCE_ID) as GeoJSONSource | null;
}

function ensureRouteAuditLayers(map: MapboxMap): GeoJSONSource | null {
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
      'line-occlusion-opacity': 0.9,
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
      'line-occlusion-opacity': 0.92,
    },
  });

  return map.getSource(ROUTE_AUDIT_SOURCE_ID) as GeoJSONSource | null;
}

function ensureForbiddenZoneLayers(map: MapboxMap): GeoJSONSource | null {
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
    layout: {
      visibility: 'none',
    },
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
    layout: {
      visibility: 'none',
    },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ff3b30'],
      'line-width': 3,
      'line-opacity': 0.96,
      'line-emissive-strength': 1.1,
    },
  });

  return map.getSource(FORBIDDEN_ZONE_SOURCE_ID) as GeoJSONSource | null;
}

function ensureForbiddenZoneDraftLayers(map: MapboxMap): GeoJSONSource | null {
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
    layout: {
      visibility: 'none',
    },
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
    layout: {
      visibility: 'none',
    },
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
    layout: {
      visibility: 'none',
    },
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
    layout: {
      visibility: 'none',
    },
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
    layout: {
      visibility: 'none',
    },
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

function ids(itineraryId: string) {
  const safe = sanitizeId(itineraryId);
  return {
    source: `${SOURCE_PREFIX}${safe}`,
    glow: `${GLOW_PREFIX}${safe}`,
    line: `${LINE_PREFIX}${safe}`,
  };
}

export interface RouteEndpoint {
  lon: number;
  lat: number;
  /** Used to pick the marker colour. */
  kind: 'start' | 'end' | 'waypoint';
  label?: string;
}

export interface RouteLayerOptions {
  /** CSS hex color (e.g. "#ff0000"). */
  color: string;
  /** Line opacity 0..1. The glow layer is scaled to 40 % of this. */
  opacity01: number;
  /** Hide the layer without removing it. */
  visible: boolean;
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
  coordinates: [number, number][],
  opts: RouteLayerOptions,
): void {
  if (!canMutateStyle(map)) return;

  const { source: srcId, glow: glowId, line: lineId } = ids(itineraryId);
  const visibility = opts.visible ? 'visible' : 'none';
  const opacity = Math.max(0, Math.min(1, opts.opacity01));

  const existing = map.getSource(srcId) as GeoJSONSource | undefined;

  if (existing) {
    try {
      existing.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates },
      });
    } catch {
      /* noop */
    }
  } else {
    map.addSource(srcId, {
      type: 'geojson',
      lineMetrics: true,
      data: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates },
      },
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
        'line-color': opts.color,
        'line-width': 10,
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
        'line-color': opts.color,
        'line-width': 4,
        'line-opacity': opacity,
        'line-emissive-strength': 1,
        'line-border-width': 1,
        'line-border-color': 'rgba(255,255,255,0.6)',
        'line-occlusion-opacity': 0.85,
      },
    });
  }

  // Always reapply paint / layout â€” cheap, ensures the layer reflects
  // the current store state regardless of the upsert path taken above.
  try {
    if (map.getLayer(glowId)) {
      map.setPaintProperty(glowId, 'line-color', opts.color);
      map.setPaintProperty(glowId, 'line-opacity', 0.4 * opacity);
      map.setLayoutProperty(glowId, 'visibility', visibility);
    }
    if (map.getLayer(lineId)) {
      map.setPaintProperty(lineId, 'line-color', opts.color);
      map.setPaintProperty(lineId, 'line-opacity', opacity);
      map.setLayoutProperty(lineId, 'visibility', visibility);
    }
    // Keep endpoint markers (if any) on top of the route lines.
    if (map.getLayer(ENDPOINT_LAYER_ID)) map.moveLayer(ENDPOINT_LAYER_ID);
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
