import type { Map as MapboxMap } from 'mapbox-gl';

const RENDER_MIN = 320;
const RENDER_MAX = 3072;

function overlayRenderDpr(canvas: HTMLCanvasElement): number {
  const clientWidth = Math.max(1, canvas.clientWidth || canvas.width || RENDER_MIN);
  const clientHeight = Math.max(1, canvas.clientHeight || canvas.height || RENDER_MIN);
  const dprX = canvas.width > 0 ? canvas.width / clientWidth : window.devicePixelRatio || 1;
  const dprY = canvas.height > 0 ? canvas.height / clientHeight : window.devicePixelRatio || 1;
  const nativeDpr = Math.max(1, Math.min(dprX, dprY));

  const nav = navigator as Navigator & {
    connection?: {
      effectiveType?: string;
      saveData?: boolean;
    };
    deviceMemory?: number;
  };

  const area = clientWidth * clientHeight;
  const constrained = !!nav.connection?.saveData
    || nav.connection?.effectiveType === 'slow-2g'
    || nav.connection?.effectiveType === '2g'
    || nav.connection?.effectiveType === '3g'
    || (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 && nav.deviceMemory <= 8)
    || (nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 6);

  if (constrained || area >= 900_000) return Math.min(nativeDpr, 1);
  if (area >= 500_000) return Math.min(nativeDpr, 1.25);
  return Math.min(nativeDpr, 1.5);
}

export function getOverlayRenderSize(map: MapboxMap): { width: number; height: number } {
  const canvas = map.getCanvas();
  const clientWidth = Math.max(RENDER_MIN, canvas.clientWidth || canvas.width || RENDER_MIN);
  const clientHeight = Math.max(RENDER_MIN, canvas.clientHeight || canvas.height || RENDER_MIN);
  const aspect = clientWidth / Math.max(1, clientHeight);
  const zoom = map.getZoom();
  const baseScale = zoom >= 10 ? 1 : zoom >= 8 ? 0.9 : zoom >= 6 ? 0.8 : 0.7;
  const dezoomSuperSample = zoom < 8 ? 2 : 1;
  const dpr = overlayRenderDpr(canvas);
  const targetWidth = Math.max(
    RENDER_MIN,
    Math.min(RENDER_MAX, Math.round(clientWidth * dpr * baseScale * dezoomSuperSample)),
  );
  const targetHeight = Math.max(RENDER_MIN, Math.min(RENDER_MAX, Math.round(targetWidth / aspect)));
  return { width: targetWidth, height: targetHeight };
}