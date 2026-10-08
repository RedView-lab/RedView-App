/**
 * sunlightMapWorker.ts — Calcul de la surcouche d'ensoleillement cumulé.
 *
 * Pour la date `isoDate` choisie et l'heure locale « actuelle », calcule pour
 * chaque pixel de la vue le nombre de MINUTES de soleil direct déjà reçues
 * depuis minuit solaire. Le résultat est coloré selon les `bands` réglées par
 * l'utilisateur (p. ex. vert 0–60 min, jaune 60–120 min, …) et renvoyé sous
 * forme de blob PNG, chargé directement comme source image Mapbox.
 *
 * Notes de conception (v2 — réécriture pour la réactivité) :
 *   • Une grille et un cache d'exposition par niveau de qualité. La clé du cache
 *     est `(sampleGen, isoDate, stepMinutes, observerTimeZone)`. La lat/lon de
 *     l'observateur N'EN FAIT PAS partie — sur une vue, la position du soleil
 *     varie bien moins que le pas d'intégration, et changer de clé à chaque
 *     dérive de la carte effacerait un cache parfaitement utilisable. Le fuseau
 *     en fait partie : il convertit les minutes d'horloge intégrées en instants.
 *   • Le temps avance → seules les tranches manquantes sont intégrées (vrai O(Δt)).
 *   • La boucle rend la main de façon asynchrone (`setTimeout(0)` toutes les
 *     BATCH_STEPS) pour que :
 *       1. les messages de progression atteignent le fil principal en cours de route ;
 *       2. une requête de calcul plus récente puisse préempter un calcul périmé en cours.
 */
import { getSunPositionForLocalMinutes } from './sun-calc';
import {
  computeHorizonSweepShadow,
  sampleViewportElevationGrid,
  type BoundsTuple,
  type ElevationGridSampleResult,
} from './dem-grid-worker';
import { applyPolygonMaskToRgba, rasterizePolygonMask } from './polygonMask';
import { rawPng } from './shadowWorkerEncoding';
import { sunlightBandIndex } from './sunlightBands';

/** Plafond visé pour la grille. ~150 k pixels gardent un balayage d'horizon ≲ 5 ms. */
const GRID_MAX_W = 448;
const GRID_MAX_H = 336;
/**
 * Pas traités avant de rendre la main à la boucle d'événements. En `preview`
 * (glissement du curseur de temps), on rend la main souvent pour qu'un calcul
 * plus récent préempte vite ; en qualité `full`, on traite bien plus de pas par
 * rendu de main, car la réactivité à l'annulation compte moins et chaque
 * rendu de main coûte ~1 ms à la boucle d'événements.
 */
const BATCH_STEPS_PREVIEW = 6;
const BATCH_STEPS_FULL = 16;
const PROGRESS_THROTTLE_MS = 90;

interface SampleRequest {
  type: 'sm-sample';
  id: number;
  bounds: BoundsTuple;
  gridW: number;
  gridH: number;
  demZoom: number;
}

interface BandSpec {
  minMinutes: number;
  maxMinutes: number;
  r: number;
  g: number;
  b: number;
  visible: boolean;
}

interface ComputeRequest {
  type: 'sm-compute';
  id: number;
  isoDate: string;
  /** Minutes depuis minuit local, 0..1440. */
  currentMinutes: number;
  /** Pas de Riemann, en minutes. */
  stepMinutes: number;
  /** Lieu et fuseau de l'observateur pour la position du soleil. */
  observerLat: number;
  observerLon: number;
  observerTimeZone: string;
  bands: BandSpec[];
  /** Multiplicateur d'alpha final de la couche, 0..1. */
  opacity: number;
  quality: 'preview' | 'full';
  /** Anneau de la zone d'analyse ([lng, lat, …]) — la sortie est masquée au polygone. */
  zoneRing?: number[] | null;
}

interface ResetRequest {
  type: 'sm-reset';
  id: number;
}

type Request = SampleRequest | ComputeRequest | ResetRequest;

interface ComputeGrid {
  elev: Float32Array;
  gridW: number;
  gridH: number;
  cellSizeX: number;
  cellSizeY: number;
  scratchShadow: Uint8Array;
  scratchShadowElev: Float32Array;
}

interface ExposureCache {
  sampleGen: number;
  isoDate: string;
  stepMinutes: number;
  observerTimeZone: string;
  /** Dernière borne de minutes cumulées réellement intégrée. */
  lastMinutes: number;
  exposure: Float32Array;
}

interface ViewportState {
  sampleGen: number;
  bounds: BoundsTuple;
  grid: ComputeGrid;
  caches: { full: ExposureCache | null; preview: ExposureCache | null };
}

let state: ViewportState | null = null;
let nextSampleGen = 1;
/** Jeton de calcul monotone utilisé pour l'annulation coopérative. */
let currentComputeToken = 0;

self.onmessage = (e: MessageEvent<Request>) => {
  const msg = e.data;
  if (msg.type === 'sm-sample') {
    handleSample(msg).catch((err) => postError(msg.id, err));
  } else if (msg.type === 'sm-compute') {
    // Incrémente le jeton AVANT l'envoi pour que toute boucle de calcul plus
    // ancienne voie que son jeton est périmé au prochain lot et abandonne.
    currentComputeToken += 1;
    const myToken = currentComputeToken;
    handleCompute(msg, myToken).catch((err) => postError(msg.id, err));
  } else if (msg.type === 'sm-reset') {
    state = null;
    currentComputeToken += 1;
    post({ id: msg.id, type: 'sm-reset-ok' });
  }
};

async function handleSample(msg: SampleRequest) {
  const cappedGridW = Math.min(GRID_MAX_W, Math.max(64, msg.gridW));
  const cappedGridH = Math.min(GRID_MAX_H, Math.max(48, msg.gridH));

  const result: ElevationGridSampleResult = await sampleViewportElevationGrid(
    msg.bounds,
    cappedGridW,
    cappedGridH,
    msg.demZoom,
  );

  if (result.tooMany) {
    post({ id: msg.id, type: 'sm-sample-ok', filled: 0, total: result.total, tooMany: true });
    return;
  }

  const grid: ComputeGrid = {
    elev: result.elev,
    gridW: cappedGridW,
    gridH: cappedGridH,
    cellSizeX: result.cellSizeX,
    cellSizeY: result.cellSizeY,
    scratchShadow: new Uint8Array(cappedGridW * cappedGridH),
    scratchShadowElev: new Float32Array(cappedGridW * cappedGridH),
  };
  const sampleGen = nextSampleGen++;
  state = { sampleGen, bounds: msg.bounds, grid, caches: { full: null, preview: null } };
  // Invalide tout calcul en cours lié à la génération précédente.
  currentComputeToken += 1;

  post({
    id: msg.id,
    type: 'sm-sample-ok',
    filled: result.filled,
    total: result.total,
    effectiveZoom: result.effectiveZoom,
    downgraded: result.downgraded,
    sampleGen,
  });
}

async function handleCompute(msg: ComputeRequest, token: number): Promise<void> {
  if (!state) {
    post({ id: msg.id, type: 'sm-compute-empty' });
    return;
  }
  const grid = state.grid;
  const cacheSlot: 'preview' | 'full' = msg.quality === 'preview' ? 'preview' : 'full';

  const currentMinutes = clamp(msg.currentMinutes, 0, 1440);
  const stepMinutes = Math.max(1, msg.stepMinutes);

  let cache = state.caches[cacheSlot];
  const cacheValid = !!cache
    && cache.sampleGen === state.sampleGen
    && cache.isoDate === msg.isoDate
    && cache.stepMinutes === stepMinutes
    && cache.observerTimeZone === msg.observerTimeZone
    && cache.exposure.length === grid.gridW * grid.gridH;

  if (!cacheValid) {
    // Réutilise le tampon précédent quand la taille de grille ne change pas (cas
    // courant : seul le dépassement de la vue a changé). Économise une allocation
    // de ~150 Ko par rééchantillonnage sur la grille d'ensoleillement. Le tampon
    // est remis à zéro plus bas ; la sentinelle NaN de l'exposition vaut 0, donc
    // une nouvelle intégration part de zéro.
    const prev = state.caches[cacheSlot];
    const reusable = prev && prev.exposure.length === grid.gridW * grid.gridH
      ? prev.exposure
      : null;
    const exposure = reusable ?? new Float32Array(grid.gridW * grid.gridH);
    if (reusable) exposure.fill(0);
    cache = {
      sampleGen: state.sampleGen,
      isoDate: msg.isoDate,
      stepMinutes,
      observerTimeZone: msg.observerTimeZone,
      lastMinutes: 0,
      exposure,
    };
  } else if (currentMinutes < cache!.lastMinutes) {
    // Retour en arrière du curseur → remise à zéro et nouvelle intégration (le cache reste chaud).
    cache!.exposure.fill(0);
    cache!.lastMinutes = 0;
  }
  state.caches[cacheSlot] = cache!;

  const exposure = cache!.exposure;
  const startMinutes = cache!.lastMinutes;
  const totalSteps = Math.max(
    0,
    Math.ceil(Math.max(0, currentMinutes - startMinutes) / stepMinutes),
  );

  if (totalSteps === 0) {
    finalizeCompute(msg, grid, exposure, currentMinutes, 0, 0, token);
    return;
  }

  let stepsDone = 0;
  let t = startMinutes;
  let lastProgressAt = 0;

  postProgress(msg.id, 0, totalSteps, t);

  // Lots plus grands en pleine qualité : moins de rendus de main = moins de
  // surcoût, et l'utilisateur ne fait pas glisser le curseur, donc la latence de
  // préemption n'est pas critique.
  const batchSteps = msg.quality === 'preview' ? BATCH_STEPS_PREVIEW : BATCH_STEPS_FULL;

  while (t < currentMinutes) {
    if (token !== currentComputeToken) {
      cache!.lastMinutes = t;
      post({ id: msg.id, type: 'sm-compute-cancelled', stepsDone, totalSteps });
      return;
    }

    const batchEnd = Math.min(currentMinutes, t + stepMinutes * batchSteps);
    while (t < batchEnd) {
      const next = Math.min(currentMinutes, t + stepMinutes);
      const dt = next - t;
      const sampleMinutes = t + dt * 0.5;
      accumulateExposureAt(
        grid,
        exposure,
        msg.isoDate,
        sampleMinutes,
        msg.observerLat,
        msg.observerLon,
        msg.observerTimeZone,
        dt,
      );
      t = next;
      stepsDone += 1;
    }

    const now = nowMs();
    if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
      postProgress(msg.id, stepsDone, totalSteps, t);
      lastProgressAt = now;
    }
    await yieldEventLoop();
  }

  cache!.lastMinutes = currentMinutes;
  finalizeCompute(msg, grid, exposure, currentMinutes, stepsDone, totalSteps, token);
}

function finalizeCompute(
  msg: ComputeRequest,
  grid: ComputeGrid,
  exposure: Float32Array,
  integratedUpToMinutes: number,
  stepsDone: number,
  totalSteps: number,
  token: number,
): void {
  if (token !== currentComputeToken) {
    post({ id: msg.id, type: 'sm-compute-cancelled', stepsDone, totalSteps });
    return;
  }
  const zoneMask = msg.zoneRing && state
    ? rasterizePolygonMask(msg.zoneRing, state.bounds, grid.gridW, grid.gridH)
    : null;
  const rgba = colorize(exposure, grid.elev, grid.gridW, grid.gridH, msg.bands, msg.opacity);
  if (zoneMask) applyPolygonMaskToRgba(rgba, zoneMask);
  const blob = new Blob([rawPng(grid.gridW, grid.gridH, rgba).buffer as ArrayBuffer], { type: 'image/png' });
  post({
    id: msg.id,
    type: 'sm-compute-ok',
    blob,
    bounds: state?.bounds ?? [0, 0, 0, 0],
    gridW: grid.gridW,
    gridH: grid.gridH,
    integratedUpToMinutes,
    quality: msg.quality,
    stepsDone,
    totalSteps,
  });
}

function accumulateExposureAt(
  grid: ComputeGrid,
  exposure: Float32Array,
  isoDate: string,
  minutesSinceMidnight: number,
  lat: number,
  lon: number,
  timeZone: string,
  dtMinutes: number,
): void {
  const sun = getSunPositionForLocalMinutes(isoDate, minutesSinceMidnight, lat, lon, timeZone);
  if (!sun) return;
  if (!Number.isFinite(sun.altitude) || sun.altitude <= 0) return;

  const mask = computeHorizonSweepShadow(
    grid.elev,
    grid.gridW,
    grid.gridH,
    sun.azimuth,
    sun.altitude,
    grid.cellSizeX,
    grid.cellSizeY,
    grid.scratchShadow,
    grid.scratchShadowElev,
  );
  const elev = grid.elev;
  // Le balayage renvoie maintenant une pénombre douce (0..255). Une cellule
  // compte comme « éclairée » quand plus de la moitié du disque solaire est
  // visible — plus proche d'un vrai compteur d'ensoleillement que l'ancien
  // binaire strict 0/255.
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] < 128 && !Number.isNaN(elev[i])) {
      exposure[i] += dtMinutes;
    }
  }
}

/** Les `bands` arrivent triées par minMinutes (serializeBands). */
function colorize(
  exposure: Float32Array,
  elev: Float32Array,
  W: number,
  H: number,
  bands: BandSpec[],
  opacity: number,
): Uint8Array {
  const alpha = Math.max(0, Math.min(255, Math.round(opacity * 255)));
  const out = new Uint8Array(W * H * 4);
  if (alpha === 0 || bands.length === 0) return out;

  for (let i = 0; i < exposure.length; i++) {
    // Pas de DEM sous la cellule : aucune exposition à signaler (se lirait « 0 min »).
    if (Number.isNaN(elev[i])) continue;
    const band = bands[sunlightBandIndex(exposure[i], bands)];
    if (!band || !band.visible) continue;
    const o = i * 4;
    out[o] = band.r;
    out[o + 1] = band.g;
    out[o + 2] = band.b;
    out[o + 3] = alpha;
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function yieldEventLoop(): Promise<void> {
  // setTimeout(0) (pas Promise.resolve) — les microtâches ne laissent pas passer
  // de nouveaux MessageEvent, ce qui empêcherait l'annulation.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function post(message: object): void {
  (self as unknown as Worker).postMessage(message);
}

function postProgress(id: number, stepsDone: number, totalSteps: number, integratedUpToMinutes: number): void {
  post({ id, type: 'sm-progress', stepsDone, totalSteps, integratedUpToMinutes });
}

function postError(id: number, err: unknown): void {
  post({ id, type: 'sm-error', message: err instanceof Error ? err.message : String(err) });
}
