import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindPoint } from '../types';

// ── Constants ─────────────────────────────────────────────────────────

export const WIND_SOURCE_ID = 'wind-data';
export const WIND_LAYER_ID = 'wind-arrows';

// Thin elongated arrow — 16 × 64 px (4:1 aspect ratio)
const ICON_W = 16;
const ICON_H = 64;

const SPEED_BANDS = [
  { key: 'w0', max: 5,        fill: '#a8d4f0', stroke: '#4a7a96' },
  { key: 'w1', max: 10,       fill: '#7ecba1', stroke: '#357a52' },
  { key: 'w2', max: 20,       fill: '#e8d44a', stroke: '#8a7a20' },
  { key: 'w3', max: 30,       fill: '#e89050', stroke: '#8a4a18' },
  { key: 'w4', max: Infinity,  fill: '#e05060', stroke: '#7a1828' },
] as const;

// ── Thin arrow icon generation ────────────────────────────────────────

function getCtx(w: number, h: number): CanvasRenderingContext2D {
  try {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    if (ctx) return ctx as unknown as CanvasRenderingContext2D;
  } catch { /* fallback */ }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext('2d')!;
}

function generateArrow(fill: string, stroke: string): ImageData {
  const ctx = getCtx(ICON_W, ICON_H);
  const cx = ICON_W / 2;

  ctx.clearRect(0, 0, ICON_W, ICON_H);

  // Long thin arrow pointing UP (north = 0°)
  ctx.beginPath();
  ctx.moveTo(cx, 2);                    // Tip
  ctx.lineTo(cx + 6, 15);               // Right wing
  ctx.lineTo(cx + 1.5, 11);             // Right notch
  ctx.lineTo(cx + 1.5, ICON_H - 3);     // Right shaft
  ctx.lineTo(cx - 1.5, ICON_H - 3);     // Left shaft
  ctx.lineTo(cx - 1.5, 11);             // Left notch
  ctx.lineTo(cx - 6, 15);               // Left wing
  ctx.closePath();

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.fillStyle = fill;
  ctx.fill();

  return ctx.getImageData(0, 0, ICON_W, ICON_H);
}

function bandKey(speed: number): string {
  for (const b of SPEED_BANDS) {
    if (speed < b.max) return b.key;
  }
  return SPEED_BANDS[SPEED_BANDS.length - 1].key;
}

export function createWindIcons(map: MapboxMap): void {
  for (const b of SPEED_BANDS) {
    if (map.hasImage(b.key)) continue;
    try {
      map.addImage(b.key, generateArrow(b.fill, b.stroke), { sdf: false });
    } catch (e) {
      console.error(`[wind] icon "${b.key}" failed:`, e);
    }
  }
}

// ── Source + Layer ─────────────────────────────────────────────────────

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function addWindLayer(map: MapboxMap): void {
  if (!map.getSource(WIND_SOURCE_ID)) {
    map.addSource(WIND_SOURCE_ID, { type: 'geojson', data: EMPTY_FC });
  }

  if (!map.getLayer(WIND_LAYER_ID)) {
    map.addLayer({
      id: WIND_LAYER_ID,
      type: 'symbol',
      source: WIND_SOURCE_ID,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-rotate': ['+', ['get', 'direction'], 180],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': [
          'interpolate', ['linear'], ['get', 'speed'],
          0, 0.35,
          5, 0.45,
          10, 0.55,
          20, 0.70,
          30, 0.85,
        ],
      },
      paint: {
        'icon-opacity': 0.88,
      },
    });
  }
}

export function updateWindData(map: MapboxMap, points: WindPoint[]): void {
  const src = map.getSource(WIND_SOURCE_ID);
  if (!src) return;

  const fc: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      properties: {
        speed: p.speed,
        direction: p.direction,
        gusts: p.gusts,
        icon: bandKey(p.speed),
      },
    })),
  };

  (src as mapboxgl.GeoJSONSource).setData(fc);
}

export function removeWindLayer(map: MapboxMap): void {
  if (map.getLayer(WIND_LAYER_ID)) map.removeLayer(WIND_LAYER_ID);
  if (map.getSource(WIND_SOURCE_ID)) map.removeSource(WIND_SOURCE_ID);
  for (const b of SPEED_BANDS) {
    if (map.hasImage(b.key)) map.removeImage(b.key);
  }
}
