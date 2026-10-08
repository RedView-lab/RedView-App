import { describe, expect, it } from 'vitest';
import { prepareFlowPyTerrain, runFlowPyToTarget, type FlowPyGrid } from './flowPy';
import {
  createFlowPyWorkerHandler,
  flowPyRecordBudget,
  runFlowPyInPool,
  type FlowPyPort,
  type FlowPyWorkerRequest,
  type FlowPyWorkerResponse,
} from './flowPyPool';

const CELL = 10;
const DEG = Math.PI / 180;

function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };
}

/** Un versant à 36° avec ravines et micro-relief au-dessus d'une vallée (plusieurs blocs de cellules de départ atteignent le point). */
function faceGrid(): FlowPyGrid {
  const rand = seeded(4);
  const width = 70;
  const height = 30;
  const altitude = new Float32Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const x = c * CELL;
      altitude[r * width + c] = 1000 + (x < 450 ? (450 - x) * Math.tan(36 * DEG) : 0) + 15 * Math.abs(Math.sin(r / 7)) + rand() * 3;
    }
  }
  return { width, height, cell: CELL, altitude };
}

/**
 * Doublure de worker dans le processus : le vrai gestionnaire, requêtes
 * traitées dans l'ordre d'arrivée comme dans un worker, réponses livrées après
 * un délai aléatoire pour que les blocs de plusieurs workers reviennent dans
 * le désordre ; messages copiés comme le ferait un clone structuré.
 */
function fakePort(rand: () => number, options: { failOnBlock?: number } = {}): FlowPyPort {
  const handle = createFlowPyWorkerHandler();
  const listeners = new Set<{ onMessage: (m: FlowPyWorkerResponse) => void; onError: (m: string) => void }>();
  let blocks = 0;
  let inbox = Promise.resolve();
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, Math.floor(rand() * 4)));
  return {
    postMessage(message: FlowPyWorkerRequest) {
      const copy = structuredClone(message);
      inbox = inbox.then(async () => {
        await later();
        if (copy.type === 'block' && ++blocks === options.failOnBlock) {
          for (const listener of listeners) listener.onError('worker crashed');
          return;
        }
        const reply = handle(copy);
        if (reply) for (const listener of listeners) listener.onMessage(structuredClone(reply));
      });
    },
    listen(onMessage, onError) {
      const listener = { onMessage, onError };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe('runFlowPyInPool', () => {
  const grid = faceGrid();
  const terrain = prepareFlowPyTerrain(grid);
  const release = new Uint8Array(grid.altitude.length);
  for (let r = 1; r < grid.height - 1; r++) for (let c = 1; c < 40; c++) release[r * grid.width + c] = 1;
  const centre = 15 * grid.width + 56;
  const target = { cells: Int32Array.of(centre - 1, centre, centre + 1, centre - grid.width, centre + grid.width) };
  const forest = Float32Array.from({ length: grid.altitude.length }, (_, i) => ((i % grid.width) > 38 && (i % grid.width) < 50 ? 0.5 : 0));

  // Références mono-thread, calculées une fois pour toutes les tailles de pool.
  const runs = [
    { alphaDeg: 18, fsi: null, release },
    { alphaDeg: 24, fsi: forest, release },
  ];
  const expected = runs.map((run) => runFlowPyToTarget(grid, terrain, target, run));

  it.each([2, 3, 5])('gives exactly the single-thread result on %i workers, blocks back in any order', async (workers) => {
    for (const [k, run] of runs.entries()) {
      expect(expected[k]!.candidates).toBeGreaterThan(3 * 64); // plusieurs blocs
      expect(expected[k]!.incomplete).toBe(false);
      const rand = seeded(workers * 7 + run.alphaDeg);
      const ports = Array.from({ length: workers }, () => fakePort(rand));
      await expect(runFlowPyInPool(ports, grid, terrain, target, run)).resolves.toEqual(expected[k]);
    }
  });

  it('runs here when there is no pool to share the work', async () => {
    await expect(runFlowPyInPool([], grid, terrain, target, runs[0]!)).resolves.toEqual(expected[0]);
  });

  it('fails when a worker does, so the caller can fall back', async () => {
    const rand = seeded(1);
    const ports = [fakePort(rand), fakePort(rand, { failOnBlock: 2 }), fakePort(rand)];
    await expect(runFlowPyInPool(ports, grid, terrain, target, { alphaDeg: 18, fsi: null, release })).rejects.toThrow('worker crashed');
  });

  it('gives several threads the time budget of one, up to four', () => {
    expect(flowPyRecordBudget(0)).toBe(flowPyRecordBudget(1));
    expect(flowPyRecordBudget(3)).toBe(3 * flowPyRecordBudget(1));
    expect(flowPyRecordBudget(8)).toBe(4 * flowPyRecordBudget(1));
  });
});
