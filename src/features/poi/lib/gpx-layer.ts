import type { Map as MapboxMap, LngLatBoundsLike } from 'mapbox-gl';

/**
 * GPX route map helpers.
 *
 * Route rendering itself is owned by the unified itinerary route-layer
 * pipeline (`features/itineraryPanel/lib/route-layer`), which paints
 * one source/glow/line triplet per itinerary keyed by its store id and
 * honours the per-itinerary visibility / opacity / colour. The legacy
 * fixed-colour `gpx-route-*` layers that used to live here have been
 * removed to avoid a second, untoggleable copy of the trace ghosting
 * the map.
 *
 * The only thing we still expose is the camera fit utility, which is
 * shared by the POI/itinerary integration.
 */

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
