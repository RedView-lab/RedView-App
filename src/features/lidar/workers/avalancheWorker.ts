/// <reference lib="webworker" />

// Exposition d'un point au terrain avalancheux (zones de départ, écoulement
// Flow-Py, classe ATES) hors du thread principal. L'indice d'abri au vent, un
// terme de terrain coûteux, est gardé entre les requêtes sur le même modèle de
// sol ; les passes Flow-Py, l'essentiel du travail (des dizaines de millions de
// cellules sur un grand versant), sont réparties sur un pool de workers
// imbriqués (flowPyPool.ts) — le même résultat qu'un seul thread, en une
// fraction du temps.

import {
  computeAvalancheTerrain,
  computeAvalancheTerrainWith,
  type AvalancheTerrainInput,
  type AvalancheTerrainResult,
} from '../viewer/tools/terrain/avalanche/exposure';
import { runFlowPyInPool, webWorkerPort, type FlowPyPort } from '../viewer/tools/terrain/avalanche/flowPyPool';
import { WindShelterField } from '../viewer/tools/terrain/avalanche/releaseArea';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

/** Nombre maximal de workers Flow-Py (le worker avalanche lui-même attend surtout). */
const MAX_FLOW_WORKERS = 8;

export interface AvalancheWorkerRequest {
  id: number;
  /** Identifie le modèle de sol (cache de l'abri au vent). */
  gridKey: string;
  input: AvalancheTerrainInput;
}

export type AvalancheWorkerResponse =
  | { id: number; type: 'done'; result: AvalancheTerrainResult | null }
  | { id: number; type: 'error'; message: string };

let wind: { key: string; field: WindShelterField } | null = null;
let pool: Worker[] | null = null;

/** Le pool Flow-Py, créé au premier usage ; vide là où les workers imbriqués sont indisponibles. */
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

// Les requêtes passent l'une après l'autre : le pool sert une tâche Flow-Py à la fois.
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
        // Un pool cassé (plantage de worker, mémoire insuffisante) n'est pas réutilisé.
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
