/**
 * sunlightMapWorker.ts — Cumulative sunshine overlay computation.
 *
 * For the chosen `isoDate` and "current" local time, computes for every
 * viewport pixel the number of MINUTES of direct sunlight that pixel has
 * already received since solar midnight. The result is colorized through
 * user-configured `bands` (e.g. green 0–60min, yellow 60–120min, …) and
 * returned as a PNG blob for direct ingestion as a Mapbox image source.
 *
 * Design notes (v2 — rewrite for responsiveness):
 *   • One grid, one exposure cache per quality tier. Cache key is
 *     `(sampleGen, isoDate, stepMinutes)`. The observer's lat/lon is NOT
 *     part of the key — across a viewport the sun position varies by far
 *     less than the integration step, so re-keying on map drift would wipe
 *     a perfectly usable cache.
 *   • Time advances → only the missing tranches are integrated (true O(Δt)).
 *   • The loop is async-yielding (`setTimeout(0)` every BATCH_STEPS) so:
 *       1. Progress messages reach the main thread mid-flight.
 *       2. A newer compute request can preempt a stale in-flight one.
 */
import { getSunPosition } from './sun-calc';
import {
  computeHorizonSweepShadow,
  sampleViewportElevationGrid,
  type BoundsTuple,
  type ElevationGridSampleResult,
} from './dem-grid-worker';
import { rawPng } from './shadowWorkerEncoding';

/** Target grid cap. ~150 k pixels keeps a single horizon sweep ≲ 5 ms. */
const GRID_MAX_W = 448;
const GRID_MAX_H = 336;
/** Steps processed before yielding to the event loop. */
const BATCH_STEPS = 6;
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
  /** Minutes since local midnight, 0..1440. */
  currentMinutes: number;
  /** Riemann step size in minutes. */
  stepMinutes: number;
  /** Sun-position observer location (viewport center). */
  centerLat: number;
  centerLon: number;
  bands: BandSpec[];
  /** 0..1 final layer alpha multiplier. */
  opacity: number;
  quality: 'preview' | 'full';
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
  /** Last cumulative minute boundary actually integrated. */
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
/** Monotonic compute token used for cooperative cancellation. */
let currentComputeToken = 0;

self.onmessage = (e: MessageEvent<Request>) => {
  const msg = e.data;
  if (msg.type === 'sm-sample') {
    handleSample(msg).catch((err) => postError(msg.id, err));
  } else if (msg.type === 'sm-compute') {
    // Bump the token BEFORE dispatching so any older compute loop notices
    // its token is stale at the next batch boundary and aborts.
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
  // Invalidate any in-flight compute bound to the previous generation.
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
    && cache.exposure.length === grid.gridW * grid.gridH;

  if (!cacheValid) {
    cache = {
      sampleGen: state.sampleGen,
      isoDate: msg.isoDate,
      stepMinutes,
      lastMinutes: 0,
      exposure: new Float32Array(grid.gridW * grid.gridH),
    };
  } else if (currentMinutes < cache!.lastMinutes) {
    // Scrubbed backwards → reset and re-integrate (cache stays warm).
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

  while (t < currentMinutes) {
    if (token !== currentComputeToken) {
      cache!.lastMinutes = t;
      post({ id: msg.id, type: 'sm-compute-cancelled', stepsDone, totalSteps });
      return;
    }

    const batchEnd = Math.min(currentMinutes, t + stepMinutes * BATCH_STEPS);
    while (t < batchEnd) {
      const next = Math.min(currentMinutes, t + stepMinutes);
      const dt = next - t;
      const sampleMinutes = t + dt * 0.5;
      accumulateExposureAt(grid, exposure, msg.isoDate, sampleMinutes, msg.centerLat, msg.centerLon, dt);
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
  const rgba = colorize(exposure, grid.gridW, grid.gridH, msg.bands, msg.opacity);
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
  dtMinutes: number,
): void {
  const date = makeLocalDateAtMinutes(isoDate, minutesSinceMidnight);
  if (!date) return;
  const sun = getSunPosition(date, lat, lon);
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
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 && !Number.isNaN(elev[i])) {
      exposure[i] += dtMinutes;
    }
  }
}

function colorize(
  exposure: Float32Array,
  W: number,
  H: number,
  bands: BandSpec[],
  opacity: number,
): Uint8Array {
  const alpha = Math.max(0, Math.min(255, Math.round(opacity * 255)));
  const out = new Uint8Array(W * H * 4);
  if (alpha === 0 || bands.length === 0) return out;

  const last = bands.length - 1;
  for (let i = 0; i < exposure.length; i++) {
    const minutes = exposure[i];
    let band: BandSpec | null = null;
    for (let b = 0; b <= last; b++) {
      const candidate = bands[b];
      if (b === last || minutes < candidate.maxMinutes) {
        band = candidate;
        break;
      }
    }
    if (!band || !band.visible) continue;
    const o = i * 4;
    out[o] = band.r;
    out[o + 1] = band.g;
    out[o + 2] = band.b;
    out[o + 3] = alpha;
  }
  return out;
}

function makeLocalDateAtMinutes(isoDate: string, minutesSinceMidnight: number): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const totalSeconds = Math.max(0, Math.round(minutesSinceMidnight * 60));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const date = new Date(year, month, day, hours, minutes, seconds);
  return Number.isNaN(date.getTime()) ? null : date;
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
  // setTimeout(0) (not Promise.resolve) — microtasks can't interleave new
  // MessageEvents, which would defeat cancellation.
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
