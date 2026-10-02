/// <reference lib="webworker" />

// Decodes a contiguous group of COPC chunks. Several of these run in parallel
// (see `decodeCopcInParallel` in viewer/runtime.ts); results are concatenated
// in chunk order so the point order matches a sequential decode.

import { decodeCopcChunks, getLazPerf, type CopcDecodeHeader } from '../lib/lazParser';
import type { PointCloudBounds, PointCloudOrigin } from '../types';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

export type CopcDecodeRequest = {
  type: 'decode';
  header: CopcDecodeHeader;
  /** Shared by every decode worker of a tile so their parts can be concatenated. */
  origin: PointCloudOrigin;
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
      intensities: Uint16Array;
      colors: Uint8Array | null;
      maxRgb: number;
      count: number;
      bounds: PointCloudBounds;
    }
  | { type: 'error'; message: string };

workerScope.onmessage = async (e: MessageEvent<CopcDecodeRequest>) => {
  if (e.data.type !== 'decode') return;
  try {
    const { header, origin, bytes, pointCounts, byteLengths, wasmModule } = e.data;
    const lazPerf = await getLazPerf(wasmModule);
    const all = new Uint8Array(bytes);
    let offset = 0;
    const chunks = pointCounts.map((pointCount, index) => {
      const length = byteLengths[index]!;
      const chunk = { pointCount, bytes: all.subarray(offset, offset + length) };
      offset += length;
      return chunk;
    });
    const decoded = decodeCopcChunks(lazPerf, header, chunks, origin, (done, total) => {
      workerScope.postMessage({ type: 'progress', done, total } satisfies CopcDecodeResponse);
    });
    const transfer: Transferable[] = [decoded.positions.buffer, decoded.classifications.buffer, decoded.intensities.buffer];
    if (decoded.colors) transfer.push(decoded.colors.buffer);
    workerScope.postMessage({ type: 'done', ...decoded } satisfies CopcDecodeResponse, transfer);
  } catch (err: unknown) {
    workerScope.postMessage({ type: 'error', message: (err as Error)?.message || String(err) } satisfies CopcDecodeResponse);
  }
};
