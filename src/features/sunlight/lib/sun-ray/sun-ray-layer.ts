/**
 * Sun Ray — Geographic line anchored to terrain coordinates.
 *
 * Unlike the previous screen-space fullscreen-quad approach, this uses a
 * standard Mapbox GeoJSON source + line layer. The line is defined by two
 * geographic points (anchor + far source along the sun direction), so it
 * stays 100% static on the map when the camera rotates/pans — exactly like
 * the shadow image overlay.
 *
 * A circle layer draws the "impact" marker at the anchor point.
 */
import type { Map as MapboxMap, GeoJSONSource } from 'mapbox-gl';

export const SUN_RAY_LAYER_ID = 'sun-ray';
const SUN_RAY_SOURCE_ID = 'sun-ray-src';
const SUN_RAY_CIRCLE_LAYER_ID = 'sun-ray-circle';

// ── Color helpers ──────────────────────────────────────────────────────

function sunRayColorFromAltitude(altitudeDeg: number): string {
  if (altitudeDeg <= 6) return 'rgba(255, 230, 209, 0.88)';
  if (altitudeDeg <= 22) return 'rgba(250, 242, 224, 0.88)';
  return 'rgba(245, 247, 250, 0.88)';
}

function sunRayCircleColorFromAltitude(altitudeDeg: number): string {
  if (altitudeDeg <= 6) return 'rgba(255, 240, 220, 0.92)';
  if (altitudeDeg <= 22) return 'rgba(252, 248, 235, 0.92)';
  return 'rgba(248, 250, 253, 0.92)';
}

// ── Geographic computation ─────────────────────────────────────────────

/**
 * Given an anchor [lng, lat] and a sun azimuth + altitude, compute a 3D
 * source point along the sun direction.  The horizontal offset gives
 * [lng, lat] and the altitude angle gives the height above ground.
 */
function computeSourcePoint(
  anchorLng: number,
  anchorLat: number,
  anchorElevation: number,
  azimuthDeg: number,
  altitudeDeg: number,
  horizontalDistKm: number,
): [number, number, number] {
  const azRad = (azimuthDeg * Math.PI) / 180;
  const altRad = (altitudeDeg * Math.PI) / 180;
  const horizM = horizontalDistKm * 1000;
  // East and North offsets in metres
  const eastM = Math.sin(azRad) * horizM;
  const northM = Math.cos(azRad) * horizM;
  // Approximate degrees per metre at this latitude
  const cosLat = Math.cos((anchorLat * Math.PI) / 180);
  const dLng = eastM / (111320 * Math.max(cosLat, 0.01));
  const dLat = northM / 110540;
  // Height above anchor: tan(altitude) × horizontal distance
  const heightM = Math.tan(Math.max(altRad, 0.01)) * horizM;
  return [anchorLng + dLng, anchorLat + dLat, anchorElevation + heightM];
}

// ── State ──────────────────────────────────────────────────────────────

let currentMap: MapboxMap | null = null;
let currentAzimuthDeg = 180;
let currentAltitudeDeg = 45;
let currentAnchorLng = 0;
let currentAnchorLat = 0;
let currentAnchorElevation = 0;

// ── Ensure source + layers ─────────────────────────────────────────────

function buildGeoJSON(
  anchorLng: number,
  anchorLat: number,
  anchorElevation: number,
  azimuthDeg: number,
  altitudeDeg: number,
): GeoJSON.FeatureCollection {
  // Horizontal distance for the ray — shorter when sun is high, longer at dusk.
  const horizDistKm = 8 + (1 - Math.max(0, Math.sin((altitudeDeg * Math.PI) / 180))) * 12;
  const [srcLng, srcLat, srcAlt] = computeSourcePoint(
    anchorLng, anchorLat, anchorElevation,
    azimuthDeg, altitudeDeg, horizDistKm,
  );

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'ray' },
        geometry: {
          type: 'LineString',
          // 3D coordinates: [lng, lat, altitude_meters]
          // Anchor at terrain level, source rises into the sky.
          coordinates: [
            [anchorLng, anchorLat, anchorElevation],
            [srcLng, srcLat, srcAlt],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { kind: 'anchor' },
        geometry: {
          type: 'Point',
          coordinates: [anchorLng, anchorLat, anchorElevation],
        },
      },
    ],
  };
}

function ensureSourceAndLayers(map: MapboxMap): void {
  if (!map.getSource(SUN_RAY_SOURCE_ID)) {
    map.addSource(SUN_RAY_SOURCE_ID, {
      type: 'geojson',
      data: buildGeoJSON(currentAnchorLng, currentAnchorLat, currentAnchorElevation, currentAzimuthDeg, currentAltitudeDeg),
    });
  }

  if (!map.getLayer(SUN_RAY_LAYER_ID)) {
    map.addLayer({
      id: SUN_RAY_LAYER_ID,
      type: 'line',
      source: SUN_RAY_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'ray'],
      paint: {
        'line-color': sunRayColorFromAltitude(currentAltitudeDeg),
        'line-width': 2.5,
        'line-opacity': currentAltitudeDeg >= 12
          ? 0.82
          : Math.max(0.16, Math.min(0.82, (currentAltitudeDeg + 2) / 18)),
        'line-blur': 1.2,
        'line-emissive-strength': 1,
      },
      layout: {
        'line-cap': 'round',
        // Interpret the 3rd coordinate as metres above sea level
        'line-elevation-reference': 'sea',
      },
    } as never);
  }

  if (!map.getLayer(SUN_RAY_CIRCLE_LAYER_ID)) {
    map.addLayer({
      id: SUN_RAY_CIRCLE_LAYER_ID,
      type: 'circle',
      source: SUN_RAY_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'anchor'],
      paint: {
        'circle-radius': 7,
        'circle-color': 'transparent',
        'circle-stroke-color': sunRayCircleColorFromAltitude(currentAltitudeDeg),
        'circle-stroke-width': 2,
        'circle-stroke-opacity': 0.85,
      },
    } as never);
  }
}

// ── Update data + style ────────────────────────────────────────────────

function applyUpdate(map: MapboxMap): void {
  const src = map.getSource(SUN_RAY_SOURCE_ID) as GeoJSONSource | undefined;
  if (!src) return;

  src.setData(buildGeoJSON(currentAnchorLng, currentAnchorLat, currentAnchorElevation, currentAzimuthDeg, currentAltitudeDeg));

  const lineColor = sunRayColorFromAltitude(currentAltitudeDeg);
  const lineOpacity = currentAltitudeDeg >= 12
    ? 0.82
    : Math.max(0.16, Math.min(0.82, (currentAltitudeDeg + 2) / 18));

  try {
    map.setPaintProperty(SUN_RAY_LAYER_ID, 'line-color', lineColor);
    map.setPaintProperty(SUN_RAY_LAYER_ID, 'line-opacity', lineOpacity);
    map.setPaintProperty(SUN_RAY_CIRCLE_LAYER_ID, 'circle-stroke-color', sunRayCircleColorFromAltitude(currentAltitudeDeg));
  } catch {
    /* layer might not exist yet */
  }
}

// ── Public API (same signatures as before) ─────────────────────────────

export function addSunRayLayer(map: MapboxMap): void {
  currentMap = map;
  try {
    ensureSourceAndLayers(map);
  } catch (err) {
    console.warn('[sun-ray] addSunRayLayer failed', err);
  }
}

export function removeSunRayLayer(map: MapboxMap): void {
  try { if (map.getLayer(SUN_RAY_CIRCLE_LAYER_ID)) map.removeLayer(SUN_RAY_CIRCLE_LAYER_ID); } catch { /* */ }
  try { if (map.getLayer(SUN_RAY_LAYER_ID)) map.removeLayer(SUN_RAY_LAYER_ID); } catch { /* */ }
  try { if (map.getSource(SUN_RAY_SOURCE_ID)) map.removeSource(SUN_RAY_SOURCE_ID); } catch { /* */ }
  currentMap = null;
}

export function updateSunRayPosition(
  azimuthDeg: number,
  altitudeDeg: number,
  lng: number,
  lat: number,
  elevation: number,
): void {
  currentAzimuthDeg = azimuthDeg;
  currentAltitudeDeg = altitudeDeg;
  currentAnchorLng = lng;
  currentAnchorLat = lat;
  currentAnchorElevation = elevation;

  if (currentMap) {
    try {
      applyUpdate(currentMap);
    } catch {
      /* source/layers might not exist yet */
    }
  }
}