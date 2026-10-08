/// <reference lib="webworker" />

// Décode un groupe contigu de chunks COPC. Plusieurs tournent en parallèle
// (voir `decodeCopcInParallel` dans viewer/runtime.ts). Le groupe est décodé
// par lots de chunks entiers, chacun envoyé dès qu'il est prêt : la page le
// copie à sa place dans les tableaux de la tuile et le libère, de sorte qu'une
// tuile ne garde jamais ses points en double (les parties et les tableaux
// assemblés) et que la mémoire WASM d'un worker — qui ne rétrécit jamais —
// reste bornée par un lot au lieu de tout son groupe. Les points sortent dans
// l'ordre des chunks, exactement comme un décodage unique du groupe. Le
// décodeur LAZ de RedView (lib/laz/) est utilisé quand son module est fourni,
// laz-perf sinon ou dès qu'il échoue : même sortie.

import { decodeCopcChunksWithRedviewLaz, initRedviewLaz } from '../lib/laz/redviewLaz';
import { decodeCopcChunks, getLazPerf, type CopcChunk, type CopcDecodeHeader, type DecodedCopcChunks } from '../lib/lazParser';
import type { PointCloudBounds, PointCloudOrigin } from '../types';
import { splitChunkBatches } from './copcDecodeBatches';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

export type CopcDecodeRequest = {
  type: 'decode';
  header: CopcDecodeHeader;
  /** Partagé par chaque worker de décodage d'une tuile pour que leurs parties puissent être concaténées. */
  origin: PointCloudOrigin;
  /** Octets des chunks compressés, concaténés dans l'ordre des chunks. */
  bytes: ArrayBuffer;
  pointCounts: number[];
  byteLengths: number[];
  wasmModule?: WebAssembly.Module;
  /** Décodeur LAZ de RedView, compilé sur le thread principal (lib/laz/redviewLazModule.ts). */
  redviewLazModule?: WebAssembly.Module | null;
};

export type CopcDecodeResponse =
  | { type: 'progress'; done: number; total: number }
  | {
      /** Les points suivants du groupe, dans l'ordre (les lots arrivent en séquence). */
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
