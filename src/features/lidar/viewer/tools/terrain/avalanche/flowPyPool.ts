// ============================================
// Outils du viewer LiDAR — Flow-Py sur plusieurs workers
// ============================================
//
// Les cellules de départ tournent indépendamment (flowPy.ts) : des blocs de
// cellules sont confiés aux workers d'un pool à mesure qu'ils se libèrent, et
// fusionnés dans l'ordre de départ dès que le suivant est revenu — exactement
// le résultat séquentiel, quels que soient le nombre de workers et l'ordre de
// retour des blocs. Indépendant du transport : un port est tout ce qui envoie
// des requêtes et écoute des réponses (Web Workers dans le viewer,
// worker_threads dans le bench).

import {
  createFlowPyBlockRunner,
  FLOWPY_BLOCK_STARTS,
  FlowPyMerger,
  MAX_RECORDS_PER_RUN,
  planFlowPyRun,
  type FlowPyBlock,
  type FlowPyBlockRunner,
  type FlowPyGrid,
  type FlowPyPlan,
  type FlowPyResult,
  type FlowPyRun,
  type FlowPyTarget,
  type FlowPyTerrain,
} from './flowPy';

export type FlowPyWorkerRequest =
  | {
    type: 'job';
    job: number;
    grid: FlowPyGrid;
    terrain: FlowPyTerrain;
    target: FlowPyTarget;
    run: FlowPyRun;
    plan: FlowPyPlan;
  }
  | { type: 'block'; job: number; from: number; to: number };

export type FlowPyWorkerResponse =
  | { type: 'block'; job: number; block: FlowPyBlock }
  | { type: 'error'; job: number; message: string };

export interface FlowPyPort {
  postMessage(message: FlowPyWorkerRequest): void;
  /** Écoute les réponses et l'échec du worker ; renvoie la désinscription. */
  listen(onMessage: (message: FlowPyWorkerResponse) => void, onError: (message: string) => void): () => void;
}

export function webWorkerPort(worker: Worker): FlowPyPort {
  return {
    postMessage: (message) => worker.postMessage(message),
    listen(onMessage, onError) {
      const message = (event: MessageEvent<FlowPyWorkerResponse>) => onMessage(event.data);
      const error = (event: ErrorEvent) => onError(event.message || 'Flow-Py worker failed');
      worker.addEventListener('message', message);
      worker.addEventListener('error', error);
      return () => {
        worker.removeEventListener('message', message);
        worker.removeEventListener('error', error);
      };
    },
  };
}

/** Côté worker : garde l'exécuteur de la tâche en cours et lance les blocs demandés. */
export function createFlowPyWorkerHandler(): (request: FlowPyWorkerRequest) => FlowPyWorkerResponse | null {
  let job = 0;
  let runner: FlowPyBlockRunner | null = null;
  return (request) => {
    if (request.type === 'job') {
      job = request.job;
      runner = createFlowPyBlockRunner(request.grid, request.terrain, request.target, request.run, request.plan);
      return null;
    }
    if (request.job !== job || !runner) return { type: 'error', job: request.job, message: 'Flow-Py block without its job' };
    return { type: 'block', job, block: runner(request.from, request.to) };
  };
}

/** Buffers d'un bloc, à transférer au lieu de les copier. */
export function flowPyBlockTransfer(block: FlowPyBlock): ArrayBuffer[] {
  return [block.startCells, block.startAngles, block.fluxCells, block.fluxValues, block.pathCells, block.pathZDelta]
    .map((array) => array.buffer as ArrayBuffer);
}

/**
 * Borne de coût d'une passe sur `threads` threads : le même budget de temps
 * qu'un thread avec MAX_RECORDS_PER_RUN, jusqu'à l'équivalent de quatre threads.
 */
export function flowPyRecordBudget(threads: number): number {
  return MAX_RECORDS_PER_RUN * Math.max(1, Math.min(4, threads));
}

let nextJob = 1;

/** Lance Flow-Py depuis chaque cellule de départ qui peut atteindre la cible, sur les workers du pool. */
export function runFlowPyInPool(
  ports: readonly FlowPyPort[],
  grid: FlowPyGrid,
  terrain: FlowPyTerrain,
  target: FlowPyTarget,
  run: FlowPyRun,
): Promise<FlowPyResult> {
  const plan = planFlowPyRun(grid, terrain, target, run);
  const total = plan.starts.length;
  const merger = new FlowPyMerger(grid.altitude.length, target, plan, flowPyRecordBudget(ports.length));
  if (ports.length < 2 || total <= FLOWPY_BLOCK_STARTS) {
    const runBlock = createFlowPyBlockRunner(grid, terrain, target, run, plan);
    while (!merger.done) {
      const from = merger.nextStart;
      merger.add(runBlock(from, Math.min(total, from + FLOWPY_BLOCK_STARTS)));
    }
    return Promise.resolve(merger.result());
  }

  const job = nextJob++;
  // Seulement ce que lisent les workers (la grille d'analyse en porte davantage).
  const jobGrid: FlowPyGrid = { width: grid.width, height: grid.height, cell: grid.cell, altitude: grid.altitude };
  const back = new Map<number, FlowPyBlock>();
  let nextFrom = 0;
  let inFlight = 0;

  return new Promise<FlowPyResult>((resolve, reject) => {
    let settled = false;
    const unsubscribe: Array<() => void> = [];
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      for (const stop of unsubscribe) stop();
      outcome();
    };
    const dispatch = (port: FlowPyPort) => {
      if (merger.done || nextFrom >= total) return;
      const from = nextFrom;
      nextFrom = Math.min(total, from + FLOWPY_BLOCK_STARTS);
      inFlight++;
      port.postMessage({ type: 'block', job, from, to: nextFrom });
    };
    for (const port of ports) {
      unsubscribe.push(port.listen((data) => {
        if (settled || data.job !== job) return;
        if (data.type === 'error') {
          settle(() => reject(new Error(data.message)));
          return;
        }
        inFlight--;
        back.set(data.block.from, data.block);
        for (let block = back.get(merger.nextStart); block && !merger.done; block = back.get(merger.nextStart)) {
          back.delete(block.from);
          merger.add(block);
        }
        if (merger.done || (inFlight === 0 && nextFrom >= total)) {
          settle(() => resolve(merger.result()));
          return;
        }
        dispatch(port);
      }, (message) => settle(() => reject(new Error(message)))));
      port.postMessage({ type: 'job', job, grid: jobGrid, terrain, target, run, plan });
    }
    // Deux blocs en file par worker : le suivant est là quand un bloc se termine.
    for (let round = 0; round < 2; round++) for (const port of ports) dispatch(port);
  });
}
