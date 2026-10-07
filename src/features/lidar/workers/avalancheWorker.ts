/// <reference lib="webworker" />

// Avalanche terrain exposure of a point (release areas, Flow-Py runout, ATES
// class) off the main thread. The wind shelter index, a costly terrain term,
// is kept between requests on the same ground model; the Flow-Py runs, the
// bulk of the work (tens of millions of cells on a large face), are spread
// over a pool of nested workers (flowPyPool.ts) — the same result as one
// thread, in a fraction of the time.

import {
  computeAvalancheTerrain,
  computeAvalancheTerrainWith,
  type AvalancheTerrainInput,
  type AvalancheTerrainResult,
} from '../viewer/tools/terrain/avalanche/exposure';
import { runFlowPyInPool, webWorkerPort, type FlowPyPort } from '../viewer/tools/terrain/avalanche/flowPyPool';
import { WindShelterField } from '../viewer/tools/terrain/avalanche/releaseArea';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

/** Flow-Py workers at most (the avalanche worker itself mostly waits). */
const MAX_FLOW_WORKERS = 8;

export interface AvalancheWorkerRequest {
  id: number;
  /** Identifies the ground model (wind shelter cache). */
  gridKey: string;
  input: AvalancheTerrainInput;
}

export type AvalancheWorkerResponse =
  | { id: number; type: 'done'; result: AvalancheTerrainResult | null }
  | { id: number; type: 'error'; message: string };

let wind: { key: string; field: WindShelterField } | null = null;
let pool: Worker[] | null = null;

/** The Flow-Py pool, created on first use; empty where nested workers are unavailable. */
function flowPool(): Worker[] {
  if (pool) return pool;
  const size = Math.min(MAX_FLOW_WORKERS, (navigator.hardwareConcurrency || 2) - 1);
  pool = [];
  if (size < 2 || typeof Worker === 'undefined') return pool;
  try {
    for (let i = 0; i < size; i++) {
      pool.push(new Worker(new URL('./flowPyWorker.ts', import.meta.url), { type: 'module' }));
    }
  } catch (error) {
    console.warn('[LiDAR tools] Flow-Py workers unavailable, single thread:', error);
    for (const worker of pool) worker.terminate();
    pool = [];
  }
  return pool;
}

function dropPool(): void {
  for (const worker of pool ?? []) worker.terminate();
  pool = [];
}

// Requests run one after the other: the pool serves one Flow-Py job at a time.
let queue: Promise<void> = Promise.resolve();

workerScope.onmessage = (e: MessageEvent<AvalancheWorkerRequest>) => {
  queue = queue.then(() => handle(e.data));
};

async function handle({ id, gridKey, input }: AvalancheWorkerRequest): Promise<void> {
  try {
    if (!wind || wind.key !== gridKey) wind = { key: gridKey, field: new WindShelterField(input.grid) };
    const ports: FlowPyPort[] = flowPool().map(webWorkerPort);
    let result: AvalancheTerrainResult | null;
    if (ports.length >= 2) {
      try {
        result = await computeAvalancheTerrainWith(input, wind.field, (grid, terrain, target, run) =>
          runFlowPyInPool(ports, grid, terrain, target, run));
      } catch (error) {
        // A pool that broke (worker crash, out of memory) is not reused.
        console.warn('[LiDAR tools] Flow-Py pool failed, single thread:', error);
        dropPool();
        result = computeAvalancheTerrain(input, wind.field);
      }
    } else {
      result = computeAvalancheTerrain(input, wind.field);
    }
    const transfer: Transferable[] = result
      ? [result.releaseCells.buffer, result.releaseTypical.buffer, result.pathCells.buffer, result.pathZDelta.buffer, result.pathTypical.buffer]
      : [];
    workerScope.postMessage({ id, type: 'done', result } satisfies AvalancheWorkerResponse, transfer);
  } catch (err: unknown) {
    workerScope.postMessage({ id, type: 'error', message: (err as Error)?.message || String(err) } satisfies AvalancheWorkerResponse);
  }
}
