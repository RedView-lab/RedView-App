import { beforeAll, describe, expect, it } from 'vitest';
import { decodeCopcChunks, getLazPerf, type CopcChunk, type CopcDecodeHeader, type DecodedCopcChunks } from '../lib/lazParser';
import { decodeCopcChunksWithRedviewLaz, initRedviewLaz } from '../lib/laz/redviewLaz';
import { splitChunkBatches } from './copcDecodeBatches';

// Le tsconfig de l'app n'a pas les types Node : node:fs via process.getBuiltinModule (Node ≥ 22.3).
const { readFileSync } = (globalThis as unknown as {
  process: { getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL): Uint8Array } };
}).process.getBuiltinModule('node:fs');
const read = (path: string) => new Uint8Array(readFileSync(new URL(path, import.meta.url)));

describe('splitChunkBatches', () => {
  const chunk = (pointCount: number) => ({ pointCount });

  it('keeps whole chunks, in order, under the point cap', () => {
    const chunks = [chunk(5), chunk(4), chunk(3), chunk(6), chunk(1)];
    const batches = splitChunkBatches(chunks, 9);
    expect(batches.map((batch) => batch.map((c) => c.pointCount))).toEqual([[5, 4], [3, 6], [1]]);
    expect(batches.flat()).toEqual(chunks);
  });

  it('gives a chunk bigger than the cap a batch of its own', () => {
    expect(splitChunkBatches([chunk(2), chunk(20), chunk(2)], 9).map((batch) => batch.length)).toEqual([1, 1, 1]);
    expect(splitChunkBatches([], 9)).toEqual([]);
  });
});

/** Concaténation des lots décodés, comme la page assemble les parties des workers. */
function concat(parts: DecodedCopcChunks[]): DecodedCopcChunks {
  const count = parts.reduce((sum, part) => sum + part.count, 0);
  const out: DecodedCopcChunks = {
    positions: new Float32Array(count * 3),
    classifications: new Uint8Array(count),
    intensities: new Uint16Array(count),
    colors: null,
    maxRgb: 0,
    count,
    bounds: { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity },
  };
  let at = 0;
  for (const part of parts) {
    out.positions.set(part.positions, at * 3);
    out.classifications.set(part.classifications, at);
    out.intensities.set(part.intensities, at);
    out.maxRgb = Math.max(out.maxRgb, part.maxRgb);
    out.bounds = {
      minX: Math.min(out.bounds.minX, part.bounds.minX), minY: Math.min(out.bounds.minY, part.bounds.minY),
      minZ: Math.min(out.bounds.minZ, part.bounds.minZ), maxX: Math.max(out.bounds.maxX, part.bounds.maxX),
      maxY: Math.max(out.bounds.maxY, part.bounds.maxY), maxZ: Math.max(out.bounds.maxZ, part.bounds.maxZ),
    };
    at += part.count;
  }
  return out;
}

describe('batched COPC decode', () => {
  /** Deux vrais nœuds de la tuile IGN LiDAR HD LHD_FXX_0965_6500 (voir lib/laz/redviewLaz.test.ts). */
  let chunks: CopcChunk[] = [];
  const header: CopcDecodeHeader = { pointDataRecordFormat: 6, pointDataRecordLength: 30, scale: [0.01, 0.01, 0.01], offset: [0, 0, 0] };
  const origin = { x: 965000, y: 6499000, z: 0 };

  beforeAll(async () => {
    const fixture = read('../lib/laz/__fixtures__/ign-0965-6500-two-chunks.laz');
    chunks = [
      { pointCount: 1621, bytes: fixture.subarray(0, 11559) },
      { pointCount: 1872, bytes: fixture.subarray(11559, 11559 + 17941) },
    ];
    initRedviewLaz(await WebAssembly.compile(read('../lib/laz/pkg/redviewlaz_bg.wasm')));
  });

  it('gives exactly the points of a single decode, with either decoder', async () => {
    const batches = splitChunkBatches(chunks, 2000);
    expect(batches).toHaveLength(2);
    const whole = decodeCopcChunksWithRedviewLaz(header, chunks, origin);
    expect(concat(batches.map((batch) => decodeCopcChunksWithRedviewLaz(header, batch, origin)))).toEqual(whole);
    const lazPerf = await getLazPerf(await WebAssembly.compile(read('../../../../public/laz-perf.wasm')));
    expect(concat(batches.map((batch) => decodeCopcChunks(lazPerf, header, batch, origin)))).toEqual(whole);
  });
});
