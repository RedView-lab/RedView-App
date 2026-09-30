/// <reference lib="webworker" />

// Decodes a contiguous group of COPC chunks. Several of these run in parallel
// (see `decodeCopcInParallel` in viewer/runtime.ts); results are concatenated
// in chunk order so the point order matches a sequential decode.

import { decodeCopcChunks, getLazPerf, type CopcDecodeHeader } from '../lib/lazParser';
import type { PointCloudBounds } from '../types';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

export type CopcDecodeRequest = {
  type: 'decode';
  header: CopcDecodeHeader;
  /** Compressed chunk bytes, concatenated in chunk order. */
  bytes: ArrayBuffer;
  pointCounts: number[];
  byteLengths: number[];
  wasmModule?: WebAssembly.Module;
};

export type CopcDecodeResponse =
  | { type: 'progress'; done: number; total: number }
  | {
      type: 'done';
      positions: Float32Array;
      classifications: Uint8Array;
      count: number;
      bounds: PointCloudBounds;
    }
  | { type: 'error'; message: string };

workerScope.onmessage = async (e: MessageEvent<CopcDecodeRequest>) => {
  if (e.data.type !== 'decode') return;
  try {
    const { header, bytes, pointCounts, byteLengths, wasmModule } = e.data;
    const lazPerf = await getLazPerf(wasmModule);
    const all = new Uint8Array(bytes);
    let offset = 0;
    const chunks = pointCounts.map((pointCount, index) => {
      const length = byteLengths[index]!;
      const chunk = { pointCount, bytes: all.subarray(offset, offset + length) };
      offset += length;
      return chunk;
    });
    const decoded = decodeCopcChunks(lazPerf, header, chunks, (done, total) => {
      workerScope.postMessage({ type: 'progress', done, total } satisfies CopcDecodeResponse);
    });
    workerScope.postMessage(
      { type: 'done', ...decoded } satisfies CopcDecodeResponse,
      [decoded.positions.buffer, decoded.classifications.buffer],
    );
  } catch (err: unknown) {
    workerScope.postMessage({ type: 'error', message: (err as Error)?.message || String(err) } satisfies CopcDecodeResponse);
  }
};
