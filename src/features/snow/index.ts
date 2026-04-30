// ============================================================================
// Snow feature — Public orchestrator
// ----------------------------------------------------------------------------
// runSnowPipeline(heightmap) → fetch AROME via Open-Meteo → worker redistribute
// → SnowField (à passer au renderer).
// ============================================================================

import { fetchAromeSnowGrid } from './lib/aromeFetcher';
import { DEFAULT_SNOW_CONFIG, type SnowRedistributionConfig } from './lib/config';
import type { SnowField, SnowHeightmap, SnowProgress } from './types';

export type { SnowField, SnowHeightmap, SnowDisplayMode, SnowProgress } from './types';
export { DEFAULT_SNOW_CONFIG } from './lib/config';

interface WorkerProgress { type: 'progress'; pct: number; label: string }
interface WorkerDone { type: 'done'; result: { data: ArrayBuffer; width: number; height: number; meanCm: number; maxCm: number; coveragePct: number } }
interface WorkerError { type: 'error'; message: string }
type WorkerMsg = WorkerProgress | WorkerDone | WorkerError;

export async function runSnowPipeline(
  heightmap: SnowHeightmap,
  options?: {
    config?: Partial<SnowRedistributionConfig>;
    progress?: SnowProgress;
    signal?: AbortSignal;
  },
): Promise<SnowField> {
  const config: SnowRedistributionConfig = { ...DEFAULT_SNOW_CONFIG, ...(options?.config ?? {}) };
  const progress = options?.progress ?? (() => {});
  const signal = options?.signal;
  const t0 = performance.now();

  progress(0, 'Récupération AROME (Météo-France)…');
  const arome = await fetchAromeSnowGrid(heightmap, signal);
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  progress(1, 'Initialisation pipeline…');

  // Transferable copies pour le worker
  const aromeBuf = arome.snowDepthCm.slice().buffer;
  const hmBuf = heightmap.data.slice().buffer;

  const worker = new Worker(new URL('./lib/redistributeWorker.ts', import.meta.url), { type: 'module' });

  const onAbort = () => worker.terminate();
  signal?.addEventListener('abort', onAbort);

  const result = await new Promise<{ data: Float32Array; width: number; height: number; meanCm: number; maxCm: number; coveragePct: number }>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const m = e.data;
      if (m.type === 'progress') {
        progress(m.pct, m.label);
      } else if (m.type === 'done') {
        resolve({
          data: new Float32Array(m.result.data),
          width: m.result.width,
          height: m.result.height,
          meanCm: m.result.meanCm,
          maxCm: m.result.maxCm,
          coveragePct: m.result.coveragePct,
        });
      } else {
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'snow worker error'));
    worker.postMessage(
      {
        type: 'compute',
        payload: {
          aromeData: aromeBuf,
          aromeW: arome.width,
          aromeH: arome.height,
          aromeBounds: arome.boundsMeters,
          heightmap: hmBuf,
          terrainW: heightmap.width,
          terrainH: heightmap.height,
          terrainOrigin: [heightmap.bounds.minX, heightmap.bounds.minY],
          terrainSize: [heightmap.bounds.maxX - heightmap.bounds.minX, heightmap.bounds.maxY - heightmap.bounds.minY],
          config,
        },
      },
      [aromeBuf, hmBuf],
    );
  }).finally(() => {
    signal?.removeEventListener('abort', onAbort);
    worker.terminate();
  });

  const elapsed = performance.now() - t0;

  return {
    data: result.data,
    width: result.width,
    height: result.height,
    boundsMeters: [heightmap.bounds.minX, heightmap.bounds.minY, heightmap.bounds.maxX, heightmap.bounds.maxY],
    stats: {
      meanCm: result.meanCm,
      maxCm: result.maxCm,
      coveragePct: result.coveragePct,
      elapsedMs: elapsed,
    },
    arome: {
      timestamp: arome.timestamp,
      runHour: arome.runHour,
      source: arome.source,
    },
  };
}
