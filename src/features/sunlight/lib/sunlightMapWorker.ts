/**
 * sunlightMapWorker.ts — Cumulative sunshine overlay computation.
 *
 * For the chosen `isoDate` and "current" local time, computes for every
 * viewport pixel the number of MINUTES of direct sunlight that pixel has
 * already received since solar midnight. The result is colorized through
 * user-configured `bands` (e.g. green 0–60min, yellow 60–120min, …) and
 * returned as a PNG blob for direct ingestion as a Mapbox image source.
 *
 * Pipeline:
 *   1. `sample` — build a Float32 elevation grid for the viewport (cached
 *      between time-scrubs so only the compute step pays the cost).
 *   2. `compute` — iterate `t ∈ [0, currentMinutes]` step `stepMinutes`,
 *      compute the sun position at the viewport center, run the horizon
 *      sweep, and accumulate per-pixel exposure (rectangular Riemann sum).
 *      The exposure buffer is cached so subsequent time advances only run
 *      the additional steps (true incremental mode).
 *   3. Colorize → encode RGBA PNG → post back to main thread.
 *
 * Per-step quality:
 *   • `preview`   — coarse grid (≤ 320×240), step ≥ 15 min — used while the
 *     user drags the time slider.
 *   • `full`      — uses the native sample grid (capped at 512×384 for the
 *     sunlight pass — bands are too coarse to benefit from finer detail and
 *     cumulative compute scales linearly with pixel count).
 */
import { getSunPosition } from './sun-calc';
import {
  computeHorizonSweepShadow,
  sampleViewportElevationGrid,
  type BoundsTuple,
  type ElevationGridSampleResult,
} from './dem-grid-worker';
import { rawPng } from './shadowWorkerEncoding';

const FULL_GRID_MAX_W = 512;
const FULL_GRID_MAX_H = 384;
const PREVIEW_GRID_MAX_W = 320;
const PREVIEW_GRID_MAX_H = 240;

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
  /** Riemann step size in minutes (e.g. 10). */
  stepMinutes: number;
  /** Sun-position observer location (we use the viewport center). */
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
  /** Sample generation id this cache belongs to. */
  sampleGen: number;
  isoDate: string;
  centerLat: number;
  centerLon: number;
  stepMinutes: number;
  quality: 'preview' | 'full';
  /** Last cumulative minute boundary actually integrated. */
  lastMinutes: number;
  /** Float32 cumulative exposure (minutes) per pixel. */
  exposure: Float32Array;
}

interface ViewportState {
  sampleGen: number;
  bounds: BoundsTuple;
  /** Native grid as returned by the sampler (capped to FULL_GRID_MAX_*). */
  full: ComputeGrid;
  /** Optional downsampled grid for time-scrubbing. */
  preview: ComputeGrid | null;
  /** Cached exposure buffers — at most one per quality tier. */
  caches: { full: ExposureCache | null; preview: ExposureCache | null };
}

let state: ViewportState | null = null;
let nextSampleGen = 1;

self.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data;
  try {
    if (msg.type === 'sm-sample') {
      await handleSample(msg);
    } else if (msg.type === 'sm-compute') {
      handleCompute(msg);
    } else if (msg.type === 'sm-reset') {
      state = null;
      (self as unknown as Worker).postMessage({ id: msg.id, type: 'sm-reset-ok' });
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      type: 'sm-error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function handleSample(msg: SampleRequest) {
  // Cap the native grid: cumulative compute scales linearly with pixels and
  // bands are coarse, so > 512×384 wastes CPU with no visible gain.
  const cappedGridW = Math.min(FULL_GRID_MAX_W, msg.gridW);
  const cappedGridH = Math.min(FULL_GRID_MAX_H, msg.gridH);

  const result: ElevationGridSampleResult = await sampleViewportElevationGrid(
    msg.bounds,
    cappedGridW,
    cappedGridH,
    msg.demZoom,
  );

  if (result.tooMany) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      type: 'sm-sample-ok',
      filled: 0,
      total: result.total,
      tooMany: true,
    });
    state = null;
    return;
  }

  const full: ComputeGrid = {
    elev: result.elev,
    gridW: cappedGridW,
    gridH: cappedGridH,
    cellSizeX: result.cellSizeX,
    cellSizeY: result.cellSizeY,
    scratchShadow: new Uint8Array(cappedGridW * cappedGridH),
    scratchShadowElev: new Float32Array(cappedGridW * cappedGridH),
  };
  const preview = buildPreviewGrid(full);
  const sampleGen = nextSampleGen++;
  state = {
    sampleGen,
    bounds: msg.bounds,
    full,
    preview,
    caches: { full: null, preview: null },
  };

  (self as unknown as Worker).postMessage({
    id: msg.id,
    type: 'sm-sample-ok',
    filled: result.filled,
    total: result.total,
    effectiveZoom: result.effectiveZoom,
    downgraded: result.downgraded,
    sampleGen,
  });
}

function buildPreviewGrid(src: ComputeGrid): ComputeGrid | null {
  const stepX = Math.max(1, Math.ceil(src.gridW / PREVIEW_GRID_MAX_W));
  const stepY = Math.max(1, Math.ceil(src.gridH / PREVIEW_GRID_MAX_H));
  if (stepX === 1 && stepY === 1) return null;

  const gridW = Math.max(1, Math.ceil(src.gridW / stepX));
  const gridH = Math.max(1, Math.ceil(src.gridH / stepY));
  const elev = new Float32Array(gridW * gridH);
  for (let r = 0; r < gridH; r++) {
    const srcR = Math.min(src.gridH - 1, r * stepY + ((stepY - 1) >> 1));
    for (let c = 0; c < gridW; c++) {
      const srcC = Math.min(src.gridW - 1, c * stepX + ((stepX - 1) >> 1));
      elev[r * gridW + c] = src.elev[srcR * src.gridW + srcC];
    }
  }
  return {
    elev,
    gridW,
    gridH,
    cellSizeX: src.cellSizeX * stepX,
    cellSizeY: src.cellSizeY * stepY,
    scratchShadow: new Uint8Array(gridW * gridH),
    scratchShadowElev: new Float32Array(gridW * gridH),
  };
}

function handleCompute(msg: ComputeRequest) {
  if (!state) {
    (self as unknown as Worker).postMessage({ id: msg.id, type: 'sm-compute-empty' });
    return;
  }
  const grid = msg.quality === 'preview' ? (state.preview ?? state.full) : state.full;
  const cacheSlot: 'preview' | 'full' = msg.quality === 'preview' && state.preview ? 'preview' : 'full';
  const cached = state.caches[cacheSlot];

  const currentMinutes = clamp(msg.currentMinutes, 0, 1440);
  const stepMinutes = Math.max(1, msg.stepMinutes);

  let cache = cached;
  const cacheMatches = !!cache
    && cache.sampleGen === state.sampleGen
    && cache.isoDate === msg.isoDate
    && cache.centerLat === msg.centerLat
    && cache.centerLon === msg.centerLon
    && cache.stepMinutes === stepMinutes
    && cache.quality === msg.quality
    && cache.exposure.length === grid.gridW * grid.gridH;

  if (!cacheMatches) {
    cache = {
      sampleGen: state.sampleGen,
      isoDate: msg.isoDate,
      centerLat: msg.centerLat,
      centerLon: msg.centerLon,
      stepMinutes,
      quality: msg.quality,
      lastMinutes: 0,
      exposure: new Float32Array(grid.gridW * grid.gridH),
    };
  } else if (currentMinutes < cache!.lastMinutes) {
    // Time moved backwards — reset and recompute up to the new boundary.
    cache!.exposure.fill(0);
    cache!.lastMinutes = 0;
  }

  // Integrate from `lastMinutes` up to `currentMinutes` in `stepMinutes`
  // increments. Each integration window contributes its `dt` to every pixel
  // that was lit at the window's midpoint sample (sun above the horizon AND
  // no terrain blocking).
  const exposure = cache!.exposure;
  let t = cache!.lastMinutes;
  while (t < currentMinutes) {
    const next = Math.min(currentMinutes, t + stepMinutes);
    const dt = next - t;
    // Midpoint sample yields better accuracy for the Riemann sum without
    // doubling the cost of a trapezoidal rule.
    const sampleMinutes = t + dt * 0.5;
    accumulateExposureAt(grid, exposure, msg.isoDate, sampleMinutes, msg.centerLat, msg.centerLon, dt);
    t = next;
  }
  cache!.lastMinutes = currentMinutes;
  state.caches[cacheSlot] = cache!;

  const rgba = colorize(exposure, grid.gridW, grid.gridH, msg.bands, msg.opacity);
  const blob = new Blob([rawPng(grid.gridW, grid.gridH, rgba).buffer as ArrayBuffer], { type: 'image/png' });

  (self as unknown as Worker).postMessage({
    id: msg.id,
    type: 'sm-compute-ok',
    blob,
    bounds: state.bounds,
    gridW: grid.gridW,
    gridH: grid.gridH,
    integratedUpToMinutes: currentMinutes,
    quality: msg.quality,
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

  // Sun below the horizon → no exposure delta for this window. We do NOT
  // skip the loop because we still need to ensure exposure isn't decreased.
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
  // mask: 0 = lit, 255 = cast-shadow. Lit pixels get the full `dt`.
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 && !Number.isNaN(grid.elev[i])) {
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

  // Bands are pre-sorted ascending by minMinutes on the main thread. Above
  // the last band's maxMinutes we clamp into the last band (still useful
  // information: "saturated daylight zone").
  const last = bands.length - 1;
  for (let i = 0; i < exposure.length; i++) {
    const minutes = exposure[i];
    let band: BandSpec | null = null;
    for (let b = 0; b <= last; b++) {
      const candidate = bands[b];
      if (b === last) {
        band = candidate;
        break;
      }
      if (minutes < candidate.maxMinutes) {
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
