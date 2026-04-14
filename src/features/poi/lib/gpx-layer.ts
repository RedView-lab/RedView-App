import type { Map as MapboxMap, LngLatBoundsLike } from 'mapbox-gl';

const GPX_SOURCE_ID = 'gpx-route-source';
const GPX_GLOW_LAYER_ID = 'gpx-route-glow';
const GPX_LINE_LAYER_ID = 'gpx-route-line';

/** Add a GPX route as a styled line on the map. */
export function addGpxRoute(
  map: MapboxMap,
  points: { lat: number; lon: number }[],
): void {
  removeGpxRoute(map);

  const coordinates = points.map((p) => [p.lon, p.lat]);

  map.addSource(GPX_SOURCE_ID, {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    },
  });

  // Outer glow layer
  map.addLayer({
    id: GPX_GLOW_LAYER_ID,
    type: 'line',
    source: GPX_SOURCE_ID,
    slot: 'top',
    paint: {
      'line-color': '#ff6b35',
      'line-width': 7,
      'line-opacity': 0.35,
      'line-blur': 3,
    },
  });

  // Core line layer
  map.addLayer({
    id: GPX_LINE_LAYER_ID,
    type: 'line',
    source: GPX_SOURCE_ID,
    slot: 'top',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ff6b35',
      'line-width': 3,
      'line-opacity': 0.9,
    },
  });
}

/** Remove GPX route layers & source from the map. */
export function removeGpxRoute(map: MapboxMap): void {
  try {
    if (map.getLayer(GPX_LINE_LAYER_ID)) map.removeLayer(GPX_LINE_LAYER_ID);
    if (map.getLayer(GPX_GLOW_LAYER_ID)) map.removeLayer(GPX_GLOW_LAYER_ID);
    if (map.getSource(GPX_SOURCE_ID)) map.removeSource(GPX_SOURCE_ID);
  } catch { /* map might be destroyed */ }
}

/** Fit the map view to the GPX route bounds. */
export function fitMapToRoute(
  map: MapboxMap,
  points: { lat: number; lon: number }[],
): void {
  if (points.length === 0) return;

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const bounds: LngLatBoundsLike = [
    [minLon, minLat],
    [maxLon, maxLat],
  ];

  map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 800 });
}
