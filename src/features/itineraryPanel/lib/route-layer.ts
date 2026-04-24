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
import { Marker, type Map as MapboxMap, type LngLatBoundsLike, type GeoJSONSource } from 'mapbox-gl';

const SOURCE_PREFIX = 'brouter-route-source-';
const GLOW_PREFIX = 'brouter-route-glow-';
const LINE_PREFIX = 'brouter-route-line-';

const START_SOURCE_ID = 'brouter-endpoints-source';
const ENDPOINT_LAYER_ID = 'brouter-endpoints-layer';
const ANALYSIS_HOVER_SOURCE_ID = 'brouter-analysis-hover-source';
const ANALYSIS_HOVER_HALO_LAYER_ID = 'brouter-analysis-hover-halo-layer';
const ANALYSIS_HOVER_POINT_LAYER_ID = 'brouter-analysis-hover-point-layer';

const analysisHoverMarkers = new WeakMap<MapboxMap, Marker>();

function ensureAnalysisHoverMarker(map: MapboxMap, color: string): Marker {
  const existing = analysisHoverMarkers.get(map);
  if (existing) {
    syncAnalysisHoverMarkerColor(existing.getElement(), color);
    return existing;
  }

  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.style.width = '26px';
  element.style.height = '26px';
  element.style.borderRadius = '999px';
  element.style.pointerEvents = 'none';
  element.style.display = 'flex';
  element.style.alignItems = 'center';
  element.style.justifyContent = 'center';
  element.style.boxSizing = 'border-box';
  element.style.background = 'rgba(255, 255, 255, 0.18)';
  element.style.backdropFilter = 'blur(1px)';
  element.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.35), 0 0 18px rgba(255,255,255,0.35)';

  const core = document.createElement('div');
  core.dataset.role = 'analysis-hover-core';
  core.style.width = '10px';
  core.style.height = '10px';
  core.style.borderRadius = '999px';
  core.style.boxSizing = 'border-box';
  core.style.border = '2px solid rgba(255,255,255,0.98)';
  core.style.boxShadow = '0 0 12px rgba(255,255,255,0.45)';
  element.appendChild(core);

  syncAnalysisHoverMarkerColor(element, color);

  const marker = new Marker({
    element,
    anchor: 'center',
    rotationAlignment: 'map',
    pitchAlignment: 'map',
  }).addTo(map);
  analysisHoverMarkers.set(map, marker);
  return marker;
}

function syncAnalysisHoverMarkerColor(element: HTMLElement, color: string): void {
  const core = element.querySelector<HTMLElement>('[data-role="analysis-hover-core"]');
  if (!core) return;

  core.style.background = color;
  element.style.boxShadow = `0 0 0 1px rgba(255,255,255,0.35), 0 0 18px ${hexToRgba(color, 0.45)}`;
}

function hexToRgba(color: string, alpha: number): string {
  const normalized = color.trim();
  const match = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return `rgba(255,255,255,${alpha})`;

  const hex = match[1].length === 3
    ? match[1].split('').map((part) => `${part}${part}`).join('')
    : match[1];
  const value = Number.parseInt(hex, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red},${green},${blue},${alpha})`;
}

function sanitizeId(id: string): string {
  // Mapbox source/layer ids must be safe â€” strip anything weird.
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
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
  const marker = ensureAnalysisHoverMarker(map, point.color ?? '#ffffff');
  marker.setLngLat([point.lon, point.lat]);
}

export function clearAnalysisHoverPoint(map: MapboxMap): void {
  const marker = analysisHoverMarkers.get(map);
  if (marker) {
    marker.remove();
    analysisHoverMarkers.delete(map);
  }

  try {
    if (map.getLayer(ANALYSIS_HOVER_POINT_LAYER_ID)) {
      map.removeLayer(ANALYSIS_HOVER_POINT_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_HOVER_HALO_LAYER_ID)) {
      map.removeLayer(ANALYSIS_HOVER_HALO_LAYER_ID);
    }
    if (map.getSource(ANALYSIS_HOVER_SOURCE_ID)) map.removeSource(ANALYSIS_HOVER_SOURCE_ID);
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
