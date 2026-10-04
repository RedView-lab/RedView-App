/// <reference lib="webworker" />

// Avalanche terrain exposure of a point (release areas, Flow-Py runout, ATES
// class) off the main thread: a few seconds of compute on steep scenes. The
// wind shelter index, the costliest terrain term, is kept between requests
// on the same ground model.

import { computeAvalancheTerrain, type AvalancheTerrainInput, type AvalancheTerrainResult } from '../viewer/tools/terrain/avalanche/exposure';
import { WindShelterField } from '../viewer/tools/terrain/avalanche/releaseArea';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

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

workerScope.onmessage = (e: MessageEvent<AvalancheWorkerRequest>) => {
  const { id, gridKey, input } = e.data;
  try {
    if (!wind || wind.key !== gridKey) wind = { key: gridKey, field: new WindShelterField(input.grid) };
    const result = computeAvalancheTerrain(input, wind.field);
    const transfer: Transferable[] = result
      ? [result.releaseCells.buffer, result.releaseTypical.buffer, result.pathCells.buffer, result.pathZDelta.buffer, result.pathTypical.buffer]
      : [];
    workerScope.postMessage({ id, type: 'done', result } satisfies AvalancheWorkerResponse, transfer);
  } catch (err: unknown) {
    workerScope.postMessage({ id, type: 'error', message: (err as Error)?.message || String(err) } satisfies AvalancheWorkerResponse);
  }
};
