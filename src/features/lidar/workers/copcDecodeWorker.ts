/// <reference lib="webworker" />

// Decodes a contiguous group of COPC chunks. Several of these run in parallel
// (see `decodeCopcInParallel` in viewer/runtime.ts). The group is decoded in
// batches of whole chunks, each posted as soon as it is ready: the page copies
// it into place in the tile's arrays and drops it, so a tile never holds its
// points twice (the parts and the assembled arrays) and a worker's WASM memory
// — which never shrinks — stays bounded by one batch instead of its whole group.
// Points come out in chunk order, exactly as a single decode of the group. The
// RedView LAZ decoder (lib/laz/) is used when its module is given, laz-perf
// otherwise or once it fails: same output.

import { decodeCopcChunksWithRedviewLaz, initRedviewLaz } from '../lib/laz/redviewLaz';
import { decodeCopcChunks, getLazPerf, type CopcChunk, type CopcDecodeHeader, type DecodedCopcChunks } from '../lib/lazParser';
import type { PointCloudBounds, PointCloudOrigin } from '../types';
import { splitChunkBatches } from './copcDecodeBatches';

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
  /** RedView LAZ decoder, compiled on the main thread (lib/laz/redviewLazModule.ts). */
  redviewLazModule?: WebAssembly.Module | null;
};

export type CopcDecodeResponse =
  | { type: 'progress'; done: number; total: number }
  | {
      /** The next points of the group, in order (batches arrive in sequence). */
      type: 'part';
      positions: Float32Array;
      classifications: Uint8Array;
      intensities: Uint16Array;
      colors: Uint8Array | null;
      maxRgb: number;
      count: number;
      bounds: PointCloudBounds;
    }
  | { type: 'done'; count: number }
  | { type: 'error'; message: string };

workerScope.onmessage = async (e: MessageEvent<CopcDecodeRequest>) => {
  if (e.data.type !== 'decode') return;
  try {
    const { header, origin, bytes, pointCounts, byteLengths, wasmModule, redviewLazModule } = e.data;
    const all = new Uint8Array(bytes);
    let offset = 0;
    const chunks: CopcChunk[] = pointCounts.map((pointCount, index) => {
      const length = byteLengths[index]!;
      const chunk = { pointCount, bytes: all.subarray(offset, offset + length) };
      offset += length;
      return chunk;
    });
    let useRedviewLaz = !!redviewLazModule;
    if (redviewLazModule) {
      try {
        initRedviewLaz(redviewLazModule);
      } catch (error) {
        console.warn('[LiDAR] LAZ decoder unavailable, decoding with laz-perf:', error);
        useRedviewLaz = false;
      }
    }
    let total = 0;
    let chunksDone = 0;
    for (const batch of splitChunkBatches(chunks)) {
      const progress = (done: number) => {
        workerScope.postMessage({ type: 'progress', done: chunksDone + done, total: chunks.length } satisfies CopcDecodeResponse);
      };
      let decoded: DecodedCopcChunks | null = null;
      if (useRedviewLaz) {
        try {
          decoded = decodeCopcChunksWithRedviewLaz(header, batch, origin, progress);
        } catch (error) {
          console.warn('[LiDAR] LAZ decoder failed, decoding with laz-perf:', error);
          useRedviewLaz = false;
        }
      }
      decoded ??= decodeCopcChunks(await getLazPerf(wasmModule), header, batch, origin, progress);
      chunksDone += batch.length;
      total += decoded.count;
      const transfer: Transferable[] = [decoded.positions.buffer, decoded.classifications.buffer, decoded.intensities.buffer];
      if (decoded.colors) transfer.push(decoded.colors.buffer);
      workerScope.postMessage({ type: 'part', ...decoded } satisfies CopcDecodeResponse, transfer);
    }
    workerScope.postMessage({ type: 'done', count: total } satisfies CopcDecodeResponse);
  } catch (err: unknown) {
    workerScope.postMessage({ type: 'error', message: (err as Error)?.message || String(err) } satisfies CopcDecodeResponse);
  }
};
