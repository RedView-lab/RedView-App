/**
 * Types et aides partagés de `useSunlightMap`.
 *
 * Reprend le découpage de `useShadowImage` (shared.ts / hook.ts) pour que les
 * surcouches d'ombres portées et d'ensoleillement cumulé gardent la même
 * structure.
 */
import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  OverlayReloadRegistrar,
  OverlayStatusReporter,
} from '@/features/map3d';
import type { SunlightBand } from '@/features/controlPanel/types';
import {
  adaptiveOvershoot,
  sunAltitudeOvershootBucket,
} from '@/features/sunlight/lib/shadowSweep';

export const SUNLIGHT_MAP_SOURCE_ID = 'sunlight-map-image';
export const SUNLIGHT_MAP_LAYER_ID = 'sunlight-map-image';

export const COMPUTE_DEBOUNCE_MS = 40;

const GRID_MIN_W = 384;
const GRID_MIN_H = 288;
const GRID_MAX_W = 1024;
const GRID_MAX_H = 768;
const DEM_MIN_SAMPLE_ZOOM = 4;
const DEM_MAX_SAMPLE_ZOOM = 13;
export const BOUNDS_OVERSHOOT = 0.10;
export const BLOB_REVOKE_DELAY_MS = 1500;

/**
 * Pas d'intégration de Riemann (minutes). 15 min est un bon compromis entre
 * précision (≈ 4° de résolution en azimut près du midi solaire) et coût de
 * calcul (≈ 56 balayages pour une photopériode de 14 h). Un pas UNIQUE fait
 * que le cache du worker est commun aux requêtes de glissement et de pleine
 * qualité.
 */
export const STEP_MINUTES = 15;

/** Taux de remplissage acceptable avant d'arrêter de relancer l'échantillonnage. */
export const MIN_USABLE_SAMPLE_FILL_RATIO = 0.65;
export const STYLE_PREPARATION_RETRY_DELAY_MS = 250;
export const PARTIAL_SAMPLE_RETRY_DELAY_MS = 1200;
export const MAX_PARTIAL_SAMPLE_RETRIES = 3;

export type BoundsTuple = [number, number, number, number];
type ComputeQuality = 'preview' | 'full';

/**
 * Restriction des surcouches d'ensoleillement à la zone d'analyse : la grille
 * DEM est échantillonnée sur `bounds` (l'emprise du polygone + un dépassement
 * adaptatif pour les ombres projetées depuis l'extérieur de la zone) et le PNG
 * de sortie est masqué en alpha par `ring`.
 */
interface SunlightAnalysisZone {
  /** Clé stable — un changement force un rééchantillonnage complet. */
  key: string;
  /** Emprise du polygone [ouest, sud, est, nord]. */
  bounds: BoundsTuple;
  /** Anneau fermé à plat [lng, lat, lng, lat, …] envoyé aux workers. */
  ring: number[];
}

export interface UseSunlightMapOptions {
  enabled: boolean;
  /** ISO YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
  /** Point d'observation utilisé pour tous les calculs solaires. */
  observerLat: number | null;
  observerLon: number | null;
  observerTimeZone: string | null;
  /** Vrai pendant que l'utilisateur fait glisser le curseur de temps. */
  timeScrubbing: boolean;
  /** Opacité de la surcouche, 0..1. */
  opacity: number;
  /** Bandes de couleur réglées par l'utilisateur. */
  bands: readonly SunlightBand[];
  /** Zone d'analyse qui restreint la surcouche (widget conditionné à une zone). */
  analysisZone?: SunlightAnalysisZone | null;
}

export interface UseSunlightMapRuntimeOptions {
  statusReporter?: OverlayStatusReporter;
  registerReload?: OverlayReloadRegistrar;
}

// ── Protocole du worker ────────────────────────────────────────────────────

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
  stepsDone: number;
  totalSteps: number;
}

interface SmComputeProgress {
  id: number;
  type: 'sm-progress';
  stepsDone: number;
  totalSteps: number;
  integratedUpToMinutes: number;
}

export interface SmComputeCancelled {
  id: number;
  type: 'sm-compute-cancelled';
  stepsDone: number;
  totalSteps: number;
}

export interface SmComputeEmpty {
  id: number;
  type: 'sm-compute-empty';
}

interface SmResetAck {
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
  | SmComputeProgress
  | SmComputeCancelled
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

/**
 * Choisit un facteur de dépassement de la vue qui grandit quand le soleil
 * baisse, pour que les sommets hors écran projettent encore leur ombre dans la
 * zone visible pendant l'intégration de l'ensoleillement cumulé (soleil bas →
 * ombres très longues → dépassement plus large).
 *
 * Rangé par classe d'altitude du soleil : le DEM n'est rééchantillonné que
 * quand la classe change (≤5°, ≤10°, ≤15°, ≤25°), pas à chaque pixel d'un
 * glissement du curseur de temps.
 *
 * @param rawBounds      Emprise de la vue (ouest, sud, est, nord) AVANT dépassement.
 * @param sunAltitudeDeg Altitude représentative du soleil sur la période intégrée.
 *                       Les appelants passent en général l'altitude à l'heure
 *                       courante, bonne approximation de la pire longueur d'ombre.
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
    return { overshoot: NaN, bucket, resample: false };
  }
  const [w, , e, n] = rawBounds;
  const midLat = n;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const viewportWidthM = ((e - w) * Math.PI * 6378137 * cosLat) / 180;
  const overshoot = adaptiveOvershoot(sunAltitudeDeg, NaN, viewportWidthM);
  return { overshoot, bucket, resample: true };
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

// ── Variantes en zone d'analyse ────────────────────────────────────────────
// Même budget que les versions vue, mais dimensionné sur l'emprise de la zone :
// la grille garde toute sa résolution concentrée sur le polygone, donc une
// petite zone reçoit un échantillon bien plus fin en mètres par cellule que la
// vue entière.

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
    /* rien à faire */
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
        // La teinte d'ensoleillement doit passer SOUS la couche d'ombres portées
        // pour que les crêtes sombres restent lisibles au-dessus des zones
        // vertes / jaunes / rouges. La couche d'ombres utilise le slot `top` de
        // Mapbox ; sans slot, la couche est insérée au-dessus du fond de carte
        // mais sous les couches placées dans un slot — exactement l'ordre voulu.
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
 * Sérialise les `SunlightBand[]` de l'interface en tableau adapté au worker :
 *   • couleurs hexadécimales → triplets RGB (le worker ne fait rien du DOM) ;
 *   • tri croissant par `minMinutes` pour que la boucle de coloration puisse
 *     s'arrêter tôt ;
 *   • entrées mal formées écartées sans bruit.
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

/** Empreinte légère du contenu des bandes → nouveau rendu seulement s'il change. */
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
