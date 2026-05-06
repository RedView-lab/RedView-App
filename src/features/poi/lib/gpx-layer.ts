import type { Map as MapboxMap, LngLatBoundsLike, GeoJSONSource } from 'mapbox-gl';

const GPX_SOURCE_ID = 'gpx-route-source';
const GPX_GLOW_LAYER_ID = 'gpx-route-glow';
const GPX_LINE_LAYER_ID = 'gpx-route-line';

// Lenient: only blocks when there is no style at all. `isStyleLoaded()`
// flickers to `false` on every styledata event during heavy DEM/ortho
// tile churn, so a strict check would silently abort GPX adds for
// seconds at a time. Mapbox tolerates `addSource`/`addLayer` as long as
// `getStyle()` returns a real object.
function canMutateStyle(map: MapboxMap): boolean {
  try {
    return Boolean(map.getStyle());
  } catch {
    return false;
  }
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

/** Check if the GPX source still exists on the map. */
export function isGpxRouteOnMap(map: MapboxMap): boolean {
  try {
    return !!map.getSource(GPX_SOURCE_ID);
  } catch { return false; }
}

/**
 * Add or update the GPX route. If the source already exists, its data
 * is patched in place (no flicker, no source teardown). Otherwise a
 * fresh source + glow + line triplet is created. Both branches are
 * idempotent and safe to call repeatedly from style.load / styledata
 * replay handlers.
 */
export function addGpxRoute(
  map: MapboxMap,
  points: { lat: number; lon: number }[],
): void {
  const coordinates = points.map((p) => [p.lon, p.lat]);
  const featureData: GeoJSON.Feature = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  };

  // Fast path: source already mounted → patch geometry in place. This
  // works even when `isStyleLoaded()` is transiently false during heavy
  // tile churn, which is the common case after a brouter recompute.
  const existing = map.getSource(GPX_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) {
    try {
      existing.setData(featureData);
      raiseGpxRoute(map);
      return;
    } catch {
      /* fall through to full re-add */
    }
  }

  if (!canMutateStyle(map)) return;

  // Cleanup any half-mounted layers (defensive).
  removeGpxRoute(map);

  try {
    map.addSource(GPX_SOURCE_ID, {
      type: 'geojson',
      lineMetrics: true,
      data: featureData,
    });

    // Outer glow layer — elevated above terrain so it escapes the draped
    // rendering batch where Mapbox GL may rearrange raster/line ordering.
    map.addLayer({
      id: GPX_GLOW_LAYER_ID,
      type: 'line',
      source: GPX_SOURCE_ID,
      slot: 'top',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        'line-elevation-reference': 'ground' as unknown as undefined,
        'line-z-offset': 3 as unknown as undefined,
      },
      paint: {
        'line-color': '#ff6b35',
        'line-width': 10,
        'line-opacity': 0.4,
        'line-blur': 4,
        'line-emissive-strength': 1,
      },
    });

    // Core line layer — elevated to avoid terrain drape reordering, but fully
    // occluded by 3D terrain/objects when it passes behind relief.
    map.addLayer({
      id: GPX_LINE_LAYER_ID,
      type: 'line',
      source: GPX_SOURCE_ID,
      slot: 'top',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        'line-elevation-reference': 'ground' as unknown as undefined,
        'line-z-offset': 3 as unknown as undefined,
      },
      paint: {
        'line-color': '#ff6b35',
        'line-width': 4,
        'line-opacity': 1,
        'line-emissive-strength': 1,
        'line-border-width': 1,
        'line-border-color': 'rgba(255,255,255,0.6)',
        'line-occlusion-opacity': 0,
      },
    });

    // Elevated lines render above draped content (raster/terrain) by design.
    // moveLayer keeps them at the end of the layer list as extra insurance.
    map.moveLayer(GPX_GLOW_LAYER_ID);
    map.moveLayer(GPX_LINE_LAYER_ID);
  } catch {
    /* style transitioning — replay handler will retry on next styledata */
  }
}

/** Remove GPX route layers & source from the map. */
export function removeGpxRoute(map: MapboxMap): void {
  try {
    if (map.getLayer(GPX_LINE_LAYER_ID)) map.removeLayer(GPX_LINE_LAYER_ID);
    if (map.getLayer(GPX_GLOW_LAYER_ID)) map.removeLayer(GPX_GLOW_LAYER_ID);
    if (map.getSource(GPX_SOURCE_ID)) map.removeSource(GPX_SOURCE_ID);
  } catch { /* map might be destroyed */ }
}

export function raiseGpxRoute(map: MapboxMap): void {
  try {
    if (!hasRasterLayerAbove(map, GPX_GLOW_LAYER_ID) && !hasRasterLayerAbove(map, GPX_LINE_LAYER_ID)) return;
    if (map.getLayer(GPX_GLOW_LAYER_ID)) map.moveLayer(GPX_GLOW_LAYER_ID);
    if (map.getLayer(GPX_LINE_LAYER_ID)) map.moveLayer(GPX_LINE_LAYER_ID);
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
