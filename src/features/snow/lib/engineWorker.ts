// ============================================================================
// Snow engine v2 — Web Worker
// ============================================================================

import { computeSnowDistribution } from './engine/pipeline';
import type { SnowEngineInput, SnowEngineResult } from './engine/types';

export interface EngineWorkerRequest {
  type: 'compute';
  input: SnowEngineInput;
}

export type EngineWorkerResponse =
  | { type: 'progress'; pct: number; label: string }
  | { type: 'done'; result: SnowEngineResult }
  | { type: 'error'; message: string };

const post = (msg: EngineWorkerResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<EngineWorkerRequest>) => {
  if (e.data.type !== 'compute') return;
  try {
    const result = computeSnowDistribution(e.data.input, (pct, label) => post({ type: 'progress', pct, label }));
    post({ type: 'done', result }, [result.hsCm.buffer as ArrayBuffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

export {};
