/// <reference lib="webworker" />

import { getLazPerf } from '../lib/lazParser';
import { mergeLasFiles, type LasMergeOptions } from '../lib/lasMerge';

/**
 * Fusion des morceaux de bandes d'une cellule DHMV II (Flandre) hors du fil
 * principal : décompression laz-perf de ~7 fichiers et écriture d'un LAS de
 * ~150 Mo. Le worker est jeté après usage (laz-perf garde son tas wasm).
 */

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

export interface LasMergeRequest {
  files: ArrayBuffer[];
  options: LasMergeOptions;
  wasmModule?: WebAssembly.Module;
}

export type LasMergeResponse =
  | { type: 'progress'; done: number }
  | { type: 'done'; buffer: ArrayBuffer }
  | { type: 'error'; message: string };

workerScope.onmessage = async (event: MessageEvent<LasMergeRequest>) => {
  const { files, options, wasmModule } = event.data;
  try {
    const lazPerf = await getLazPerf(wasmModule);
    const buffer = await mergeLasFiles(files, options, lazPerf, (done) => {
      workerScope.postMessage({ type: 'progress', done } satisfies LasMergeResponse);
    });
    workerScope.postMessage({ type: 'done', buffer } satisfies LasMergeResponse, [buffer]);
  } catch (err) {
    workerScope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies LasMergeResponse);
  }
};
