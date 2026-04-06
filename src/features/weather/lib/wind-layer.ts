import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindPoint } from '../types';

// ── Constants ─────────────────────────────────────────────────────────

export const WIND_SOURCE_ID = 'wind-data';
export const WIND_LAYER_ID = 'wind-arrows';
export const WIND_ICON_ID = 'wind-arrow';

// ── Arrow icon generation (Canvas → ImageData) ───────────────────────

/**
 * Generate a clean arrow icon pointing UP (north = 0°).
 * The icon is drawn as an SDF-compatible grayscale image
 * so Mapbox can recolor it via `icon-color`.
 */
function generateArrowImageData(): ImageData {
  const size = 48;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;

  const cx = size / 2;
  const cy = size / 2;

  // Clear
  ctx.clearRect(0, 0, size, size);

  // Arrow shape: slim chevron pointing up
  ctx.beginPath();
  // Tip (top center)
  ctx.moveTo(cx, 4);
  // Right wing
  ctx.lineTo(cx + 14, cy + 10);
  // Inner right notch
  ctx.lineTo(cx, cy - 2);
  // Inner left notch
  ctx.lineTo(cx - 14, cy + 10);
  ctx.closePath();

  // SDF-white fill
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Small tail bar for wind direction clarity
  ctx.beginPath();
  ctx.moveTo(cx, cy + 2);
  ctx.lineTo(cx, cy + 16);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}

/**
 * Load the wind arrow icon into the map.
 */
export function createWindArrowIcon(map: MapboxMap): void {
  if (map.hasImage(WIND_ICON_ID)) return;

  const imageData = generateArrowImageData();
  map.addImage(WIND_ICON_ID, imageData, { sdf: true });
}

// ── Source + Layer management ─────────────────────────────────────────

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

/**
 * Add wind GeoJSON source and symbol layer to the map.
 */
export function addWindLayer(map: MapboxMap): void {
  // Source
  if (!map.getSource(WIND_SOURCE_ID)) {
    map.addSource(WIND_SOURCE_ID, {
      type: 'geojson',
      data: EMPTY_FC,
    });
  }

  // Layer
  if (!map.getLayer(WIND_LAYER_ID)) {
    map.addLayer({
      id: WIND_LAYER_ID,
      type: 'symbol',
      source: WIND_SOURCE_ID,
      layout: {
        'icon-image': WIND_ICON_ID,
        // Rotate arrow to show FLOW direction (where wind blows TO)
        // Meteorological direction = where wind comes FROM, so + 180°
        'icon-rotate': ['+', ['get', 'direction'], 180],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // Scale by wind speed: calm → small, strong → large
        'icon-size': [
          'interpolate',
          ['linear'],
          ['get', 'speed'],
          0, 0.35,   // calm
          5, 0.5,    // light breeze
          10, 0.65,  // moderate
          20, 0.85,  // strong
          30, 1.0,   // storm
        ],
      },
      paint: {
        // Speed-based color ramp (SDF recoloring)
        'icon-color': [
          'interpolate',
          ['linear'],
          ['get', 'speed'],
          0,  '#88bbee',  // calm: light blue
          5,  '#44cc88',  // light: green
          10, '#eecc44',  // moderate: yellow
          20, '#ee7733',  // strong: orange
          30, '#dd3344',  // storm: red
        ],
        'icon-opacity': 0.85,
        'icon-halo-color': 'rgba(0,0,0,0.4)',
        'icon-halo-width': 0.5,
      },
    });
  }
}

/**
 * Build a GeoJSON FeatureCollection from wind data points.
 */
function buildGeoJSON(points: WindPoint[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [p.lng, p.lat],
      },
      properties: {
        speed: p.speed,
        direction: p.direction,
        gusts: p.gusts,
      },
    })),
  };
}

/**
 * Update the wind source data on the map.
 */
export function updateWindData(map: MapboxMap, points: WindPoint[]): void {
  const source = map.getSource(WIND_SOURCE_ID);
  if (!source) return;

  (source as mapboxgl.GeoJSONSource).setData(buildGeoJSON(points));
}

/**
 * Remove all wind-related resources from the map.
 */
export function removeWindLayer(map: MapboxMap): void {
  if (map.getLayer(WIND_LAYER_ID)) map.removeLayer(WIND_LAYER_ID);
  if (map.getSource(WIND_SOURCE_ID)) map.removeSource(WIND_SOURCE_ID);
  if (map.hasImage(WIND_ICON_ID)) map.removeImage(WIND_ICON_ID);
}
