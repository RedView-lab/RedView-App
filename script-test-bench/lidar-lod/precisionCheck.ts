import { performance } from 'node:perf_hooks';
import {
  computeLocalOrigin,
  decodeCopcChunks,
  type CopcChunk,
} from '../../src/features/lidar/lib/lazParser.ts';
import { check, createRandom } from './harness.ts';

// ---------------------------------------------------------------------------
// 1. Précision : decodeCopcChunks avec un laz-perf simulé
// ---------------------------------------------------------------------------

interface SyntheticRecords {
  X: Int32Array;
  Y: Int32Array;
  Z: Int32Array;
  cls: Uint8Array;
}

/** Substitut minimal du module laz-perf : getPoint() écrit l'enregistrement PDRF 6 synthétique suivant. */
function createMockLazPerf(records: SyntheticRecords) {
  const HEAPU8 = new Uint8Array(1 << 20);
  const view = new DataView(HEAPU8.buffer);
  let heapTop = 64;
  let cursor = 0;
  return {
    HEAPU8,
    _malloc(size: number): number {
      const ptr = heapTop;
      heapTop += (size + 15) & ~15;
      if (heapTop > HEAPU8.length) throw new Error('mock heap exhausted');
      return ptr;
    },
    _free(): void {},
    ChunkDecoder: class {
      open(): void {}
      getPoint(ptr: number): void {
        view.setInt32(ptr, records.X[cursor]!, true);
        view.setInt32(ptr + 4, records.Y[cursor]!, true);
        view.setInt32(ptr + 8, records.Z[cursor]!, true);
        view.setUint16(ptr + 12, 1000, true);
        HEAPU8[ptr + 16] = records.cls[cursor]!;
        cursor++;
      }
      delete(): void {}
    },
  };
}

export function runPrecisionCheck(): void {
  const count = 200_000;
  const scale = [0.01, 0.01, 0.01];
  const offset = [0, 0, 0];
  const records: SyntheticRecords = {
    X: new Int32Array(count),
    Y: new Int32Array(count),
    Z: new Int32Array(count),
    cls: new Uint8Array(count),
  };
  // Une tuile IGN type de 1 km dans les Alpes (Lambert-93), résolution centimétrique, décalage LAS 0.
  const rand = createRandom(12345);
  for (let i = 0; i < count; i++) {
    records.X[i] = Math.round((1_000_000 + rand() * 1000) / scale[0]!);
    records.Y[i] = Math.round((6_543_000 + rand() * 1000) / scale[1]!);
    records.Z[i] = Math.round((1200 + rand() * 800) / scale[2]!);
    records.cls[i] = 2;
  }

  const header = { pointDataRecordFormat: 6, pointDataRecordLength: 30, scale, offset };
  const chunks: CopcChunk[] = [{ pointCount: count, bytes: new Uint8Array(8) }];
  const origin = computeLocalOrigin([1_000_000.5, 6_543_000.5, 1200]);

  const t0 = performance.now();
  const decoded = decodeCopcChunks(createMockLazPerf(records), header, chunks, origin);
  const decodeMs = performance.now() - t0;

  let maxErrNew = 0;
  let maxErrLegacy = 0;
  const originArr = [origin.x, origin.y, origin.z];
  for (let i = 0; i < count; i++) {
    const truth = [
      records.X[i]! * scale[0]! + offset[0]!,
      records.Y[i]! * scale[1]! + offset[1]!,
      records.Z[i]! * scale[2]! + offset[2]!,
    ];
    for (let axis = 0; axis < 3; axis++) {
      maxErrNew = Math.max(maxErrNew, Math.abs(decoded.positions[i * 3 + axis]! + originArr[axis]! - truth[axis]!));
      maxErrLegacy = Math.max(maxErrLegacy, Math.abs(Math.fround(truth[axis]!) - truth[axis]!));
    }
  }

  check(
    `Précision positions (200k pts Lambert-93, décodage ${decodeMs.toFixed(0)} ms)`,
    maxErrNew < 0.001,
    `${(maxErrLegacy * 100).toFixed(1)} cm (Float32 absolu)`,
    `${(maxErrNew * 1000).toFixed(3)} mm (origine locale)`,
  );
}
