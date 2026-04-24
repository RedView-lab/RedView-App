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

function ensureAnalysisHoverLayers(map: MapboxMap): GeoJSONSource | null {
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
      'circle-radius': 10,
      'circle-color': ['coalesce', ['get', 'color'], '#ffffff'],
      'circle-opacity': 0.24,
      'circle-blur': 0.55,
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
      'circle-radius': 5.5,
      'circle-color': ['coalesce', ['get', 'color'], '#ffffff'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 1,
      'circle-stroke-opacity': 0.96,
      'circle-pitch-alignment': 'viewport',
      'circle-pitch-scale': 'viewport',
      'circle-emissive-strength': 1,
    },
  });

  return map.getSource(ANALYSIS_HOVER_SOURCE_ID) as GeoJSONSource | null;
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
  /** "start" | "end" â€” used to pick a colour. */
  kind: 'start' | 'end';
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
        'circle-radius': 7,
        'circle-color': [
          'match',
          ['get', 'kind'],
          'start',
          '#34a853',
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
