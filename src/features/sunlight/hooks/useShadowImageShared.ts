import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  OverlayReloadRegistrar,
  OverlayStatusReporter,
} from '@/features/map3d';
import {
  adaptiveOvershoot,
  sunAltitudeOvershootBucket,
} from '@/features/sunlight/lib/shadowSweep';

export const SOURCE_ID = 'shadow-image';
export const LAYER_ID = 'shadow-image';
const GRID_MIN_W = 768;
const GRID_MIN_H = 576;
const GRID_MAX_W = 1600;
const GRID_MAX_H = 1200;
const DEM_MIN_SAMPLE_ZOOM = 4;
const DEM_MAX_SAMPLE_ZOOM = 14;
export const BOUNDS_OVERSHOOT = 0.15;
export const BLOB_REVOKE_DELAY_MS = 1500;

type ComputeQuality = 'preview' | 'full';

export interface UseShadowImageOptions {
  enabled: boolean;
  sunAzimuthDeg: number;
  sunAltitudeDeg: number;
  opacity: number;
  timeScrubbing: boolean;
  /**
   * Zone d'analyse qui restreint la surcouche : grille DEM échantillonnée sur
   * l'emprise du polygone (+ dépassement adaptatif — les ombres viennent du
   * relief HORS de la zone) et PNG de sortie masqué au polygone.
   */
  analysisZone?: ShadowAnalysisZone | null;
}

interface ShadowAnalysisZone {
  /** Clé stable — un changement force un rééchantillonnage complet. */
  key: string;
  /** Emprise du polygone [ouest, sud, est, nord]. */
  bounds: BoundsTuple;
  /** Anneau fermé à plat [lng, lat, lng, lat, …] envoyé au worker. */
  ring: number[];
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
  alphaPixels?: number;
  shadowPixels?: number;
  totalPixels?: number;
}

export interface ComputeEmpty {
  id: number;
  type: 'compute-empty';
}

interface ResetAck {
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

/**
 * Intensité du voile uniforme de crépuscule / nuit envoyée au worker d'ombres
 * sous le nom `nightFloor` (0..1). Le worker l'applique comme
 * `alpha = max(castShadow, floor)` dans `encodeShadowRgba()` : quand le soleil
 * est sous l'horizon et que le tampon d'ombres portées est vide (le worker
 * s'arrête court à `sunAltDeg <= 0`), c'est la SEULE chose qui empêche la
 * surcouche d'être transparente.
 *
 * Sans lui, les images de fin de soirée / de nuit donnaient un PNG entièrement
 * transparent alors que `effectiveOverlayOpacity()` avait déjà forcé l'opacité
 * de la couche raster à 1,0 — le symptôme était « pas d'ombre / pas
 * d'assombrissement la nuit » pendant que le SW renvoyait des tuiles
 * parfaitement transparentes.
 *
 * La rampe suit les bandes de crépuscule astronomique pour que la tombée du
 * jour se lise naturellement :
 *   • soleil ≥  0°  → 0          (jour, les ombres portées font tout le travail)
 *   • soleil =  0°… −6°  crépuscule civil        → 0    → 0,30
 *   • soleil = −6°…−12°  crépuscule nautique     → 0,30 → 0,50
 *   • soleil ≤ −12°  astronomique / nuit         → 0,55 (plafonné, jamais opaque)
 */
export function computeNightFloor(altitudeDeg: number): number {
  if (!Number.isFinite(altitudeDeg) || altitudeDeg >= 0) return 0;
  const a = -altitudeDeg;
  if (a <= 6) return (a / 6) * 0.30;
  if (a <= 12) return 0.30 + ((a - 6) / 6) * 0.20;
  return 0.55;
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

// ── Variantes en zone d'analyse ────────────────────────────────────────────
// Même budget de grille que la version vue, mais dimensionné sur l'emprise de
// la zone : une petite zone reçoit un échantillon DEM bien plus fin en mètres
// par cellule (ombres plus fidèles) et demande beaucoup moins de tuiles DEM.

function mercYDeg(latDeg: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, latDeg));
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}

export function chooseZoneGridSize(zoneBounds: BoundsTuple): { gridW: number; gridH: number } {
  const [w, s, e, n] = zoneBounds;
  const dxRad = ((e - w) * Math.PI) / 180;
  const dyRad = Math.abs(mercYDeg(s) - mercYDeg(n));
  if (dxRad <= 0 || dyRad <= 0) return { gridW: GRID_MIN_W, gridH: GRID_MIN_H };
  let gw = Math.max(GRID_MIN_W, Math.min(GRID_MAX_W, GRID_MAX_W));
  let gh = Math.round((gw * dyRad) / dxRad);
  if (gh > GRID_MAX_H) {
    gh = GRID_MAX_H;
    gw = Math.round((gh * dxRad) / dyRad);
  }
  if (gh < GRID_MIN_H) {
    gh = GRID_MIN_H;
    gw = Math.round((gh * dxRad) / dyRad);
  }
  return {
    gridW: Math.max(GRID_MIN_W, Math.min(GRID_MAX_W, gw)),
    gridH: Math.max(GRID_MIN_H, Math.min(GRID_MAX_H, gh)),
  };
}

export function chooseZoneDemZoom(zoneBounds: BoundsTuple, gridW: number): number {
  const [w, s, e, n] = zoneBounds;
  const lat = (n + s) / 2;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lonExtentM = ((e - w) * Math.PI * 6378137 * cosLat) / 180;
  const targetMpp = lonExtentM / gridW;
  const ideal = Math.log2((40075016.686 * Math.abs(cosLat)) / (256 * targetMpp));
  return Math.max(DEM_MIN_SAMPLE_ZOOM, Math.min(DEM_MAX_SAMPLE_ZOOM, Math.round(ideal)));
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

/**
 * Choisit un facteur de dépassement de la vue qui grandit quand le soleil
 * baisse, pour que les sommets hors écran projettent encore leur ombre dans la
 * zone visible.
 *
 * Le facteur est rangé par classe d'altitude du soleil (voir
 * `sunAltitudeOvershootBucket`) : le DEM n'est rééchantillonné que quand le
 * soleil franchit une limite de classe (≤5°, ≤10°, ≤15°, ≤25°), pas à chaque
 * pixel d'un glissement du curseur de temps. Entre deux classes, le facteur
 * précédent est réutilisé — `lastBucket` porte la classe de l'échantillon
 * courant, et il est mis à jour sur place quand un rééchantillonnage est requis.
 *
 * @param rawBounds      Emprise de la vue (ouest, sud, est, nord) AVANT dépassement.
 * @param sunAltitudeDeg Altitude actuelle du soleil, en degrés.
 * @param lastBucket     Classe de la grille actuellement échantillonnée (ou `null` s'il n'y en a pas).
 * @returns `{ overshoot, bucket, resample }` — `resample` vaut true si et seulement
 *          si la classe a changé et que le DEM doit être rééchantillonné au nouveau dépassement.
 */
export function chooseAdaptiveOvershoot(
  rawBounds: BoundsTuple,
  sunAltitudeDeg: number,
  lastBucket: number | null,
): { overshoot: number; bucket: number; resample: boolean } {
  const bucket = sunAltitudeOvershootBucket(sunAltitudeDeg);
  if (lastBucket !== null && lastBucket === bucket) {
    // Même classe → on garde le facteur précédent ; l'appelant le met en cache.
    return { overshoot: NaN, bucket, resample: false };
  }
  const [w, , e, n] = rawBounds;
  const midLat = n; // suffisant pour le terme cos(lat)
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const viewportWidthM = ((e - w) * Math.PI * 6378137 * cosLat) / 180;
  // `adaptiveOvershoot` estime la longueur d'ombre d'un sommet typique ; la
  // hauteur de sommet par défaut qu'il contient le garde robuste avant même
  // d'avoir échantillonné le relief réel de la vue.
  const overshoot = adaptiveOvershoot(sunAltitudeDeg, NaN, viewportWidthM);
  return { overshoot, bucket, resample: true };
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

export function setShadowLayerOpacity(map: MapboxMap, opacity: number): void {
  if (!map.getLayer(LAYER_ID)) return;
  try {
    const clampedOpacity = Math.max(0, Math.min(1, opacity));
    map.setLayoutProperty(LAYER_ID, 'visibility', clampedOpacity > 0 ? 'visible' : 'none');
    map.setPaintProperty(LAYER_ID, 'raster-opacity', clampedOpacity);
  } catch {
    /* rien à faire */
  }
}

export function ensureShadowSourceAndLayer(
  map: MapboxMap,
  initialBlobUrl: string,
  coords: [[number, number], [number, number], [number, number], [number, number]],
  opts: UseShadowImageOptions,
): void {
  if (!map.getSource(SOURCE_ID)) {
    try {
      map.addSource(SOURCE_ID, {
        type: 'image',
        url: initialBlobUrl,
        coordinates: coords,
      } as never);
    } catch (err) {
      console.warn('[shadow] addSource failed', err);
      return;
    }
  }
  if (!map.getLayer(LAYER_ID)) {
    try {
      map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        slot: 'top',
        layout: {
          visibility: effectiveOverlayOpacity(opts.enabled, opts.opacity, opts.sunAltitudeDeg) > 0
            ? 'visible'
            : 'none',
        },
        paint: {
          'raster-opacity': effectiveOverlayOpacity(
            opts.enabled,
            opts.opacity,
            opts.sunAltitudeDeg,
          ),
          'raster-fade-duration': 0,
          'raster-resampling': 'linear',
        },
      } as never);
    } catch (err) {
      console.warn('[shadow] addLayer failed', err);
    }
  }
}

export function removeShadowSourceAndLayer(map: MapboxMap): void {
  try { if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID); } catch { /* */ }
  try { if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID); } catch { /* */ }
}

export function canMutateShadowStyle(map: MapboxMap): boolean {
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