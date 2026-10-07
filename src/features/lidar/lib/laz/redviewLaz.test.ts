import { beforeAll, describe, expect, it } from 'vitest';
import { decodeCopcChunks, getLazPerf, type CopcChunk, type CopcDecodeHeader } from '../lazParser';
import { decodeCopcChunksWithRedviewLaz, initRedviewLaz } from './redviewLaz';

// The app's tsconfig has no Node types: node:fs through process.getBuiltinModule (Node ≥ 22.3).
const { readFileSync } = (globalThis as unknown as {
  process: { getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL): Uint8Array } };
}).process.getBuiltinModule('node:fs');
const read = (path: string) => new Uint8Array(readFileSync(new URL(path, import.meta.url)));

/**
 * Two real nodes of IGN LiDAR HD tile LHD_FXX_0965_6500 (COPC, point format
 * 6, Etalab 2.0): 5-8-21-10 (1 621 points, a leaf) then 2-3-3-1 (1 872).
 */
let chunks: CopcChunk[] = [];
const header: CopcDecodeHeader = { pointDataRecordFormat: 6, pointDataRecordLength: 30, scale: [0.01, 0.01, 0.01], offset: [0, 0, 0] };
const origin = { x: 965000, y: 6499000, z: 0 };

describe('decodeCopcChunksWithRedviewLaz', () => {
  beforeAll(async () => {
    const fixture = read('./__fixtures__/ign-0965-6500-two-chunks.laz');
    chunks = [
      { pointCount: 1621, bytes: fixture.subarray(0, 11559) },
      { pointCount: 1872, bytes: fixture.subarray(11559, 11559 + 17941) },
    ];
    initRedviewLaz(await WebAssembly.compile(read('./pkg/redviewlaz_bg.wasm')));
  });

  it('decodes real IGN chunks exactly as laz-perf', async () => {
    const lazPerf = await getLazPerf(await WebAssembly.compile(read('../../../../../public/laz-perf.wasm')));
    const progress: number[] = [];
    const ours = decodeCopcChunksWithRedviewLaz(header, chunks, origin, (done) => progress.push(done));
    const reference = decodeCopcChunks(lazPerf, header, chunks, origin);
    expect(ours.count).toBe(3493);
    expect(progress).toEqual([1, 2]);
    expect(ours).toEqual(reference);
    // Plausible ground: inside the tile, Alpine altitudes, ASPRS classes.
    expect(ours.bounds.minX).toBeGreaterThanOrEqual(965000);
    expect(ours.bounds.maxY).toBeLessThanOrEqual(6500000);
    expect(ours.bounds.minZ).toBeGreaterThan(1900);
    expect(new Set(ours.classifications).has(2)).toBe(true);
  });

  it('refuses a truncated chunk instead of returning partial points', () => {
    const truncated = [{ pointCount: 1621, bytes: chunks[0]!.bytes.subarray(0, 3000) }];
    expect(() => decodeCopcChunksWithRedviewLaz(header, truncated, origin)).toThrow();
  });
});
