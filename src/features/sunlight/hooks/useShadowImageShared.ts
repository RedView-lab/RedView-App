import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  OverlayReloadRegistrar,
  OverlayStatusReporter,
} from '@/features/map3d/overlayStatus';

export const SOURCE_ID = 'shadow-image';
export const LAYER_ID = 'shadow-image';
export const SAMPLE_DEBOUNCE_MS = 80;
export const GRID_MIN_W = 768;
export const GRID_MIN_H = 576;
export const GRID_MAX_W = 1600;
export const GRID_MAX_H = 1200;
export const DEM_MIN_SAMPLE_ZOOM = 4;
export const DEM_MAX_SAMPLE_ZOOM = 14;
export const BOUNDS_OVERSHOOT = 0.15;
export const BLOB_REVOKE_DELAY_MS = 1500;

export type ComputeQuality = 'preview' | 'full';

export interface UseShadowImageOptions {
  enabled: boolean;
  sunAzimuthDeg: number;
  sunAltitudeDeg: number;
  opacity: number;
  timeScrubbing: boolean;
}

export interface UseShadowImageRuntimeOptions {
  statusReporter?: OverlayStatusReporter;
  registerReload?: OverlayReloadRegistrar;
}

export interface SampleAck {
  id: number;
  type: 'sample-ok';
  filled: number;
  total: number;
  tooMany?: boolean;
  effectiveZoom?: number;
  downgraded?: boolean;
}

export interface ComputeAck {
  id: number;
  type: 'compute-ok';
  blob: Blob;
  bounds: [number, number, number, number];
}

export interface ComputeEmpty {
  id: number;
  type: 'compute-empty';
}

export interface ResetAck {
  id: number;
  type: 'reset-ok';
}

export interface ErrAck {
  id: number;
  type: 'error';
  message: string;
}

export type WorkerAck = SampleAck | ComputeAck | ComputeEmpty | ResetAck | ErrAck;
export type BoundsTuple = [number, number, number, number];

export interface ComputeJob {
  bounds: BoundsTuple;
  sampleGen: number;
  computeSeq: number;
  quality: ComputeQuality;
}

export function shadowVisibility(altitudeDeg: number): number {
  return Number.isFinite(altitudeDeg) ? 1 : 0;
}

export function effectiveOverlayOpacity(enabled: boolean, opacity: number, altitudeDeg: number): number {
  if (!enabled) return 0;
  if (altitudeDeg < 0) return 1;
  return Math.max(0, Math.min(1, opacity));
}

export function chooseDemZoom(map: MapboxMap, gridW: number): number {
  const z = Math.round(map.getZoom());
  const bounds = map.getBounds();
  if (!bounds) return Math.min(DEM_MAX_SAMPLE_ZOOM, Math.max(DEM_MIN_SAMPLE_ZOOM, z));
  const w = bounds.getWest();
  const e = bounds.getEast();
  const lat = (bounds.getNorth() + bounds.getSouth()) / 2;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lonExtentM = ((e - w) * Math.PI * 6378137 * cosLat) / 180;
  const targetMpp = lonExtentM / gridW;
  const ideal = Math.log2((40075016.686 * Math.abs(cosLat)) / (256 * targetMpp));
  return Math.max(DEM_MIN_SAMPLE_ZOOM, Math.min(DEM_MAX_SAMPLE_ZOOM, Math.round(ideal)));
}

export function chooseGridSize(map: MapboxMap): { gridW: number; gridH: number } {
  const canvas = map.getCanvas();
  const cw = canvas.width || canvas.clientWidth || GRID_MIN_W;
  const ch = canvas.height || canvas.clientHeight || GRID_MIN_H;
  const aspect = cw / Math.max(1, ch);
  let w = Math.max(GRID_MIN_W, Math.min(GRID_MAX_W, cw));
  let h = Math.round(w / aspect);
  if (h > GRID_MAX_H) {
    h = GRID_MAX_H;
    w = Math.round(h * aspect);
  }
  if (h < GRID_MIN_H) {
    h = GRID_MIN_H;
    w = Math.round(h * aspect);
  }
  w = Math.max(GRID_MIN_W, Math.min(GRID_MAX_W, w));
  h = Math.max(GRID_MIN_H, Math.min(GRID_MAX_H, h));
  return { gridW: w, gridH: h };
}

export function withOvershoot(
  b: BoundsTuple,
  factor: number,
): BoundsTuple {
  const [w, s, e, n] = b;
  const dx = (e - w) * factor;
  const dy = (n - s) * factor;
  const ws = w - dx;
  const es = e + dx;
  const ss = Math.max(-85.05, s - dy);
  const ns = Math.min(85.05, n + dy);
  return [Math.max(-180, ws), ss, Math.min(180, es), ns];
}

export async function preloadBlobUrl(url: string): Promise<void> {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (img.decode) {
      await img.decode();
    } else {
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
    }
  } catch {
    /* ignore */
  }
}