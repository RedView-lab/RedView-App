// ============================================================================
// Snow feature — public orchestrator
// ----------------------------------------------------------------------------
// runSnowPipeline(heightmap):
//   1. scene geography (corners in WGS84, meridian convergence);
//   2. in parallel: AROME snow depth (±0.4°), measurements + avalanche bulletin
//      + weather history (/api/snow-context), far-field DEM (Terrarium);
//      outside the AROME domain, a coarse global-model grid instead;
//   3. model orography of the coarse cells (Terrarium);
//   4. snow engine v2 in a worker (lib/engine/pipeline.ts).
// ============================================================================

import { toWgs84, trueNorthGridBearingDeg } from '../lidar/lib/coordConvert';
import { DEFAULT_SNOW_ENGINE_CONFIG, type SnowEngineConfig } from './lib/engine/config';
import { SceneFrame } from './lib/engine/grid';
import type { CoarseSnowGrid, SceneGeo, SnowEngineInput, SnowEngineResult, SnowObservation } from './lib/engine/types';
import type { EngineWorkerRequest, EngineWorkerResponse } from './lib/engineWorker';
import { fetchAromeSnow, type AromeGrid } from './lib/sources/arome';
import { fetchSnowContext, type SnowContext } from './lib/sources/context';
import { coarseOrography, farFieldDem, terrariumSupported } from './lib/sources/terrarium';
import type { SnowField, SnowHeightmap, SnowProgress } from './types';

export type { CanopyGrid, SnowField, SnowHeightmap, SnowDisplayMode, SnowProgress, SnowObservation } from './types';
export type { SnowDiagnostics } from './lib/engine/types';
export { DEFAULT_SNOW_ENGINE_CONFIG } from './lib/engine/config';

/** Far-field DEM: margin around the scene and spacing, m. */
const FAR_MARGIN_M = 7000;
const FAR_CELL_M = 50;

function sceneGeo(h: SnowHeightmap): SceneGeo {
  const { minX, minY, maxX, maxY } = h.bounds;
  const ll = (x: number, y: number) => {
    const [lon, lat] = toWgs84(x, y, h.crs);
    return { lon, lat };
  };
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    corners: [ll(minX, minY), ll(maxX, minY), ll(maxX, maxY), ll(minX, maxY)],
    // trueNorthGridBearingDeg is where true north points on the grid; the
    // engine wants the true bearing of the grid +Y axis: the opposite.
    gridNorthBearingDeg: -trueNorthGridBearingDeg(cx, cy, h.crs),
  };
}

function runWorker(input: SnowEngineInput, progress: SnowProgress, signal?: AbortSignal): Promise<SnowEngineResult> {
  const worker = new Worker(new URL('./lib/engineWorker.ts', import.meta.url), { type: 'module' });
  const onAbort = () => worker.terminate();
  signal?.addEventListener('abort', onAbort);
  const transfer: Transferable[] = [input.dem.data.buffer as ArrayBuffer];
  if (input.canopy) transfer.push(input.canopy.data.buffer as ArrayBuffer);
  if (input.farDem) transfer.push(input.farDem.data.buffer as ArrayBuffer);
  return new Promise<SnowEngineResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<EngineWorkerResponse>) => {
      const m = e.data;
      if (m.type === 'progress') progress(40 + m.pct * 0.6, m.label);
      else if (m.type === 'done') resolve(m.result);
      else reject(new Error(m.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'snow worker error'));
    worker.postMessage({ type: 'compute', input } satisfies EngineWorkerRequest, transfer);
  }).finally(() => {
    signal?.removeEventListener('abort', onAbort);
    worker.terminate();
  });
}

export async function runSnowPipeline(
  heightmap: SnowHeightmap,
  options?: {
    /** Extra measurements (e.g. probes in the scene: kind 'point'). */
    observations?: SnowObservation[];
    config?: Partial<SnowEngineConfig>;
    progress?: SnowProgress;
    signal?: AbortSignal;
  },
): Promise<SnowField> {
  const config: SnowEngineConfig = { ...DEFAULT_SNOW_ENGINE_CONFIG, ...(options?.config ?? {}) };
  const progress = options?.progress ?? (() => {});
  const signal = options?.signal;
  const t0 = performance.now();
  const sizeX = heightmap.bounds.maxX - heightmap.bounds.minX;
  const sizeY = heightmap.bounds.maxY - heightmap.bounds.minY;

  const geo = sceneGeo(heightmap);
  const frame = new SceneFrame(geo);
  const dem = new Float32Array(heightmap.data.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < dem.length; i++) {
    const v = heightmap.data[i] + heightmap.altitudeOffsetM;
    dem[i] = v;
    if (Number.isFinite(v)) { sum += v; count++; }
  }
  const sceneAltitude = count > 0 ? sum / count : heightmap.altitudeOffsetM;

  progress(0, 'Données neige (AROME, stations, bulletin, météo)…');
  const canUseTiles = terrariumSupported();
  const [aromeRes, contextRes, farRes] = await Promise.allSettled([
    fetchAromeSnow(frame.center, signal),
    fetchSnowContext(frame.center, sceneAltitude, { coarse: false, signal }),
    canUseTiles ? farFieldDem(frame, sizeX, sizeY, FAR_MARGIN_M, FAR_CELL_M, signal) : Promise.resolve(null),
  ]);
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  let context: SnowContext | null = contextRes.status === 'fulfilled' ? contextRes.value : null;
  if (!context) console.warn('[snow] context unavailable:', contextRes.status === 'rejected' ? contextRes.reason : '');
  let coarse: CoarseSnowGrid;
  let arome: AromeGrid | null = null;
  if (aromeRes.status === 'fulfilled') {
    arome = aromeRes.value;
    coarse = arome.grid;
  } else {
    // Outside the AROME domain (or AROME down): a coarse global-model grid.
    console.warn('[snow] AROME unavailable, coarse fallback:', aromeRes.reason);
    progress(15, 'AROME indisponible : modèle global…');
    const fallback = await fetchSnowContext(frame.center, sceneAltitude, { coarse: true, signal }).catch(() => null);
    if (!fallback?.coarse) throw aromeRes.reason instanceof Error ? aromeRes.reason : new Error('snow data unavailable');
    coarse = fallback.coarse;
    context = context ?? fallback;
  }

  progress(25, 'Orographie du modèle…');
  if (canUseTiles) {
    try {
      const oro = await coarseOrography(coarse, signal);
      let known = 0;
      for (const v of oro) if (Number.isFinite(v)) known++;
      if (known > 0.5 * oro.length) coarse = { ...coarse, orographyM: oro };
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('[snow] coarse orography unavailable:', err);
    }
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  const input: SnowEngineInput = {
    dem: { data: dem, width: heightmap.width, height: heightmap.height, sizeX, sizeY },
    geo,
    coarse,
    farDem: farRes.status === 'fulfilled' ? farRes.value : null,
    canopy: heightmap.canopy ? { ...heightmap.canopy, data: new Float32Array(heightmap.canopy.data) } : null,
    observations: [...(context?.observations ?? []), ...(options?.observations ?? [])],
    bra: context?.bra ?? null,
    weather: context?.weather ?? null,
    analysisTimeMs: arome ? Date.parse(arome.timestamp) || Date.now() : Date.now(),
    config,
  };
  progress(40, 'Répartition de la neige…');
  const result = await runWorker(input, progress, signal);
  const sources = { ...(context?.sources ?? {}), arome: arome ? 'ok' : 'error', farDem: input.farDem ? 'ok' : 'unavailable', orography: coarse.orographyM ? 'ok' : 'scene-dtm' };

  return {
    data: result.hsCm,
    width: result.width,
    height: result.height,
    boundsMeters: [heightmap.bounds.minX, heightmap.bounds.minY, heightmap.bounds.maxX, heightmap.bounds.maxY],
    stats: { ...result.stats, elapsedMs: performance.now() - t0 },
    arome: {
      timestamp: arome?.timestamp ?? new Date(input.analysisTimeMs).toISOString(),
      runHour: arome?.runHour ?? '',
      source: coarse.source === 'arome' ? 'meteofrance-arome' : 'open-meteo',
    },
    diagnostics: result.diagnostics,
    sources,
  };
}
