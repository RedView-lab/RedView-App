/**
 * Mapbox layer helpers for the BRouter-computed route.
 *
 * Mirrors the structure of `features/poi/lib/gpx-layer.ts` (glow + core
 * line, elevated above terrain) but uses different ids so both layers
 * can coexist on the map.
 */
import type { Map as MapboxMap, LngLatBoundsLike } from 'mapbox-gl';

const SOURCE_ID = 'brouter-route-source';
const GLOW_ID = 'brouter-route-glow';
const LINE_ID = 'brouter-route-line';
const START_SOURCE_ID = 'brouter-endpoints-source';
const ENDPOINT_LAYER_ID = 'brouter-endpoints-layer';

export interface RouteEndpoint {
  lon: number;
  lat: number;
  /** "start" | "end" — used to pick a colour. */
  kind: 'start' | 'end';
  label?: string;
}

export function isRouteOnMap(map: MapboxMap): boolean {
  try {
    return !!map.getSource(SOURCE_ID);
  } catch {
    return false;
  }
}

export function addRoute(
  map: MapboxMap,
  coordinates: [number, number][],
  endpoints?: RouteEndpoint[],
): void {
  removeRoute(map);

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    },
  });

  map.addLayer({
    id: GLOW_ID,
    type: 'line',
    source: SOURCE_ID,
    slot: 'top',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-elevation-reference': 'ground' as unknown as undefined,
      'line-z-offset': 3 as unknown as undefined,
    },
    paint: {
      'line-color': '#c50000',
      'line-width': 10,
      'line-opacity': 0.4,
      'line-blur': 4,
      'line-emissive-strength': 1,
    },
  });

  map.addLayer({
    id: LINE_ID,
    type: 'line',
    source: SOURCE_ID,
    slot: 'top',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-elevation-reference': 'ground' as unknown as undefined,
      'line-z-offset': 3 as unknown as undefined,
    },
    paint: {
      'line-color': '#c50000',
      'line-width': 4,
      'line-opacity': 1,
      'line-emissive-strength': 1,
      'line-border-width': 1,
      'line-border-color': 'rgba(255,255,255,0.6)',
      'line-occlusion-opacity': 0.85,
    },
  });

  if (endpoints && endpoints.length > 0) {
    addEndpoints(map, endpoints);
  }

  map.moveLayer(GLOW_ID);
  map.moveLayer(LINE_ID);
  if (map.getLayer(ENDPOINT_LAYER_ID)) {
    map.moveLayer(ENDPOINT_LAYER_ID);
  }
}

function addEndpoints(map: MapboxMap, endpoints: RouteEndpoint[]): void {
  if (map.getLayer(ENDPOINT_LAYER_ID)) map.removeLayer(ENDPOINT_LAYER_ID);
  if (map.getSource(START_SOURCE_ID)) map.removeSource(START_SOURCE_ID);

  map.addSource(START_SOURCE_ID, {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: endpoints.map((p) => ({
        type: 'Feature',
        properties: { kind: p.kind, label: p.label ?? '' },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      })),
    },
  });

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

export function removeRoute(map: MapboxMap): void {
  try {
    if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID);
    if (map.getLayer(GLOW_ID)) map.removeLayer(GLOW_ID);
    if (map.getLayer(ENDPOINT_LAYER_ID)) map.removeLayer(ENDPOINT_LAYER_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    if (map.getSource(START_SOURCE_ID)) map.removeSource(START_SOURCE_ID);
  } catch {
    /* map may be tearing down */
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
