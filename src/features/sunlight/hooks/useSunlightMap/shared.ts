/**
 * Shared types & helpers for `useSunlightMap`.
 *
 * Mirrors the pattern used by `useShadowImage` (shared.ts / hook.ts split) so
 * the cast-shadow and cumulative-sunshine overlays stay structurally aligned.
 */
import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  OverlayReloadRegistrar,
  OverlayStatusReporter,
} from '@/features/map3d';
import type { SunlightBand } from '@/features/controlPanel/types';

export const SUNLIGHT_MAP_SOURCE_ID = 'sunlight-map-image';
export const SUNLIGHT_MAP_LAYER_ID = 'sunlight-map-image';

export const SAMPLE_DEBOUNCE_MS = 120;
export const COMPUTE_DEBOUNCE_MS = 40;

export const GRID_MIN_W = 384;
export const GRID_MIN_H = 288;
export const GRID_MAX_W = 1024;
export const GRID_MAX_H = 768;
export const DEM_MIN_SAMPLE_ZOOM = 4;
export const DEM_MAX_SAMPLE_ZOOM = 13;
export const BOUNDS_OVERSHOOT = 0.10;
export const BLOB_REVOKE_DELAY_MS = 1500;

/** Riemann integration step (minutes). */
export const FULL_STEP_MINUTES = 8;
export const PREVIEW_STEP_MINUTES = 20;

/** Acceptable fill ratio before we keep retrying the sample. */
export const MIN_USABLE_SAMPLE_FILL_RATIO = 0.65;
export const STYLE_PREPARATION_RETRY_DELAY_MS = 250;
export const PARTIAL_SAMPLE_RETRY_DELAY_MS = 1200;
export const MAX_PARTIAL_SAMPLE_RETRIES = 3;

export type BoundsTuple = [number, number, number, number];
export type ComputeQuality = 'preview' | 'full';

export interface UseSunlightMapOptions {
  enabled: boolean;
  /** ISO YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
  /** True while the user is dragging the time slider. */
  timeScrubbing: boolean;
  /** 0..1 overlay opacity. */
  opacity: number;
  /** User-configured colour bands. */
  bands: readonly SunlightBand[];
}

export interface UseSunlightMapRuntimeOptions {
  statusReporter?: OverlayStatusReporter;
  registerReload?: OverlayReloadRegistrar;
}

// ── Worker protocol ────────────────────────────────────────────────────────

export interface SmSampleAck {
  id: number;
  type: 'sm-sample-ok';
  filled: number;
  total: number;
  tooMany?: boolean;
  effectiveZoom?: number;
  downgraded?: boolean;
  sampleGen?: number;
}

export interface SmComputeAck {
  id: number;
  type: 'sm-compute-ok';
  blob: Blob;
  bounds: BoundsTuple;
  gridW: number;
  gridH: number;
  integratedUpToMinutes: number;
  quality: ComputeQuality;
}

export interface SmComputeEmpty {
  id: number;
  type: 'sm-compute-empty';
}

export interface SmResetAck {
  id: number;
  type: 'sm-reset-ok';
}

export interface SmErrAck {
  id: number;
  type: 'sm-error';
  message: string;
}

export type SunlightMapWorkerAck =
  | SmSampleAck
  | SmComputeAck
  | SmComputeEmpty
  | SmResetAck
  | SmErrAck;

export interface ComputeJob {
  bounds: BoundsTuple;
  sampleGen: number;
  computeSeq: number;
  quality: ComputeQuality;
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function parseTimeToMinutes(time: string): number {
  if (typeof time !== 'string') return 0;
  const match = /^(\d{1,2}):(\d{2})/u.exec(time);
  if (!match) return 0;
  const hh = Math.max(0, Math.min(23, Number(match[1])));
  const mm = Math.max(0, Math.min(59, Number(match[2])));
  return hh * 60 + mm;
}

export function withOvershoot(b: BoundsTuple, factor: number): BoundsTuple {
  const [w, s, e, n] = b;
  const dx = (e - w) * factor;
  const dy = (n - s) * factor;
  const ws = w - dx;
  const es = e + dx;
  const ss = Math.max(-85.05, s - dy);
  const ns = Math.min(85.05, n + dy);
  return [Math.max(-180, ws), ss, Math.min(180, es), ns];
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
  return {
    gridW: Math.max(GRID_MIN_W, Math.min(GRID_MAX_W, w)),
    gridH: Math.max(GRID_MIN_H, Math.min(GRID_MAX_H, h)),
  };
}

export function effectiveLayerOpacity(enabled: boolean, opacity: number): number {
  if (!enabled) return 0;
  return Math.max(0, Math.min(1, opacity));
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

export function setSunlightMapLayerOpacity(map: MapboxMap, opacity: number): void {
  if (!map.getLayer(SUNLIGHT_MAP_LAYER_ID)) return;
  try {
    const clamped = Math.max(0, Math.min(1, opacity));
    map.setLayoutProperty(SUNLIGHT_MAP_LAYER_ID, 'visibility', clamped > 0 ? 'visible' : 'none');
    map.setPaintProperty(SUNLIGHT_MAP_LAYER_ID, 'raster-opacity', clamped);
  } catch {
    /* no-op */
  }
}

export function ensureSunlightMapSourceAndLayer(
  map: MapboxMap,
  initialBlobUrl: string,
  coords: [[number, number], [number, number], [number, number], [number, number]],
  opacity: number,
): void {
  if (!map.getSource(SUNLIGHT_MAP_SOURCE_ID)) {
    try {
      map.addSource(SUNLIGHT_MAP_SOURCE_ID, {
        type: 'image',
        url: initialBlobUrl,
        coordinates: coords,
      } as never);
    } catch (err) {
      console.warn('[sunlight-map] addSource failed', err);
      return;
    }
  }
  if (!map.getLayer(SUNLIGHT_MAP_LAYER_ID)) {
    try {
      map.addLayer({
        id: SUNLIGHT_MAP_LAYER_ID,
        type: 'raster',
        source: SUNLIGHT_MAP_SOURCE_ID,
        // We want the sunlight tint to sit BELOW the cast-shadow layer so the
        // dark ridges remain readable on top of the green/yellow/red zones.
        // Mapbox's `top` slot is what the shadow layer uses; with no slot
        // specified the layer is inserted above the basemap but below
        // slot-positioned layers — exactly the order we want.
        paint: {
          'raster-opacity': Math.max(0, Math.min(1, opacity)),
          'raster-fade-duration': 0,
          'raster-resampling': 'linear',
        },
        layout: {
          visibility: opacity > 0 ? 'visible' : 'none',
        },
      } as never);
    } catch (err) {
      console.warn('[sunlight-map] addLayer failed', err);
    }
  }
}

export function removeSunlightMapSourceAndLayer(map: MapboxMap): void {
  try { if (map.getLayer(SUNLIGHT_MAP_LAYER_ID)) map.removeLayer(SUNLIGHT_MAP_LAYER_ID); } catch { /* */ }
  try { if (map.getSource(SUNLIGHT_MAP_SOURCE_ID)) map.removeSource(SUNLIGHT_MAP_SOURCE_ID); } catch { /* */ }
}

export function canMutateMapStyle(map: MapboxMap): boolean {
  try {
    const style = map.getStyle() as {
      layers?: unknown[];
      sources?: Record<string, unknown>;
      imports?: Array<{ data?: unknown }>;
    } | undefined;
    if (!style) return false;
    if (map.isStyleLoaded()) return true;
    const layerCount = style.layers?.length ?? 0;
    const sourceCount = Object.keys(style.sources ?? {}).length;
    const hasImportContent = Array.isArray(style.imports)
      && style.imports.some((entry) => entry && entry.data != null);
    return layerCount > 0 || sourceCount > 0 || hasImportContent;
  } catch {
    return false;
  }
}

export interface BandPayload {
  minMinutes: number;
  maxMinutes: number;
  r: number;
  g: number;
  b: number;
  visible: boolean;
}

/**
 * Serializes the user-facing `SunlightBand[]` into a worker-friendly array:
 *   • Hex colours → RGB triples (worker does no DOM work).
 *   • Sorted ascending by `minMinutes` so the colorize loop can short-circuit.
 *   • Discards malformed entries silently.
 */
export function serializeBands(bands: readonly SunlightBand[]): BandPayload[] {
  return bands
    .map((band) => {
      const rgb = hexToRgb(band.color);
      if (!rgb) return null;
      const minMinutes = Math.max(0, Math.round(band.minMinutes ?? 0));
      const maxMinutes = Math.max(minMinutes, Math.round(band.maxMinutes ?? minMinutes));
      return {
        minMinutes,
        maxMinutes,
        r: rgb.r,
        g: rgb.g,
        b: rgb.b,
        visible: band.visible !== false,
      } satisfies BandPayload;
    })
    .filter((b): b is BandPayload => b !== null)
    .sort((a, b) => a.minMinutes - b.minMinutes);
}

/** Lightweight content hash for the bands payload → re-render only on change. */
export function hashBandPayload(payload: BandPayload[]): string {
  return payload
    .map((b) => `${b.minMinutes}-${b.maxMinutes}-${b.r}-${b.g}-${b.b}-${b.visible ? 1 : 0}`)
    .join('|');
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (typeof hex !== 'string') return null;
  const trimmed = hex.trim().replace(/^#/u, '');
  if (trimmed.length === 3) {
    const r = parseInt(trimmed[0] + trimmed[0], 16);
    const g = parseInt(trimmed[1] + trimmed[1], 16);
    const b = parseInt(trimmed[2] + trimmed[2], 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b };
  }
  if (trimmed.length === 6) {
    const r = parseInt(trimmed.slice(0, 2), 16);
    const g = parseInt(trimmed.slice(2, 4), 16);
    const b = parseInt(trimmed.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b };
  }
  return null;
}
