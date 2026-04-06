import type { Map as MapboxMap } from 'mapbox-gl';
import type { AnimatedWindPoint } from '../types';

// ── Constants ─────────────────────────────────────────────────────────

export const WIND_SOURCE_ID = 'wind-data';
export const WIND_LAYER_ID = 'wind-arrows';

// We create multiple speed-keyed icons for color banding (no SDF needed)
const ICON_SIZE = 64;
const SPEED_BANDS = [
  { key: 'wind-arrow-0', maxSpeed: 5, color: '#6eb8e6', stroke: '#2a5a7a' },
  { key: 'wind-arrow-1', maxSpeed: 10, color: '#44cc88', stroke: '#1a6b3d' },
  { key: 'wind-arrow-2', maxSpeed: 20, color: '#eecc44', stroke: '#8a7520' },
  { key: 'wind-arrow-3', maxSpeed: 30, color: '#ee7733', stroke: '#8a3d10' },
  { key: 'wind-arrow-4', maxSpeed: Infinity, color: '#dd3344', stroke: '#7a1020' },
] as const;

// ── Arrow icon generation (Canvas → RGBA ImageData) ──────────────────

function createCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  // OffscreenCanvas preferred, fallback to DOM canvas
  try {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    if (ctx) return { canvas: c, ctx: ctx as unknown as CanvasRenderingContext2D };
  } catch { /* fallback */ }

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return { canvas: c, ctx };
}

function generateArrowImageData(fill: string, stroke: string): ImageData {
  const s = ICON_SIZE;
  const { ctx } = createCanvas(s, s);
  const cx = s / 2;

  ctx.clearRect(0, 0, s, s);

  // Draw arrow pointing UP (north = 0°)
  // Broad chevron with tail — easy to see at all zoom levels
  ctx.beginPath();
  ctx.moveTo(cx, 4);              // Tip
  ctx.lineTo(cx + 18, cx + 12);   // Right wing
  ctx.lineTo(cx + 6, cx + 2);     // Right notch
  ctx.lineTo(cx + 6, s - 10);     // Right tail
  ctx.lineTo(cx - 6, s - 10);     // Left tail
  ctx.lineTo(cx - 6, cx + 2);     // Left notch
  ctx.lineTo(cx - 18, cx + 12);   // Left wing
  ctx.closePath();

  // Dark outline for visibility over any terrain
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Colored fill
  ctx.fillStyle = fill;
  ctx.fill();

  return ctx.getImageData(0, 0, s, s);
}

function speedBandKey(speed: number): string {
  for (const b of SPEED_BANDS) {
    if (speed < b.maxSpeed) return b.key;
  }
  return SPEED_BANDS[SPEED_BANDS.length - 1].key;
}

/**
 * Load all wind arrow icon variants into the map.
 */
export function createWindArrowIcons(map: MapboxMap): void {
  for (const band of SPEED_BANDS) {
    if (map.hasImage(band.key)) continue;
    try {
      const data = generateArrowImageData(band.color, band.stroke);
      map.addImage(band.key, data, { sdf: false });
      console.log(`[wind] icon "${band.key}" registered (${ICON_SIZE}px)`);
    } catch (e) {
      console.error(`[wind] Failed to create icon "${band.key}":`, e);
    }
  }
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

  // Layer — uses per-feature icon-image from properties
  if (!map.getLayer(WIND_LAYER_ID)) {
    map.addLayer({
      id: WIND_LAYER_ID,
      type: 'symbol',
      source: WIND_SOURCE_ID,
      layout: {
        'icon-image': ['get', 'icon'],
        // Rotate arrow to show FLOW direction (meteorological + 180°)
        'icon-rotate': ['+', ['get', 'direction'], 180],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // Scale by wind speed: calm → visible, strong → large
        'icon-size': [
          'interpolate',
          ['linear'],
          ['get', 'speed'],
          0, 0.45,
          5, 0.55,
          10, 0.7,
          20, 0.85,
          30, 1.0,
        ],
      },
      paint: {
        // Per-feature opacity for fade-in/fade-out animation
        'icon-opacity': ['get', 'opacity'],
      },
    });
    console.log('[wind] layer added');
  }
}

/**
 * Build a GeoJSON FeatureCollection from animated wind points.
 */
export function buildWindGeoJSON(points: AnimatedWindPoint[]): GeoJSON.FeatureCollection {
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
        icon: speedBandKey(p.speed),
        opacity: p.opacity,
      },
    })),
  };
}

/**
 * Update the wind source data on the map.
 */
export function updateWindData(map: MapboxMap, points: AnimatedWindPoint[]): void {
  const source = map.getSource(WIND_SOURCE_ID);
  if (!source) return;

  (source as mapboxgl.GeoJSONSource).setData(buildWindGeoJSON(points));
}

/**
 * Remove all wind-related resources from the map.
 */
export function removeWindLayer(map: MapboxMap): void {
  if (map.getLayer(WIND_LAYER_ID)) map.removeLayer(WIND_LAYER_ID);
  if (map.getSource(WIND_SOURCE_ID)) map.removeSource(WIND_SOURCE_ID);
  for (const band of SPEED_BANDS) {
    if (map.hasImage(band.key)) map.removeImage(band.key);
  }
  console.log('[wind] layer removed');
}
