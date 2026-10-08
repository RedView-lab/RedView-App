import { describe, expect, it } from 'vitest';
import {
  DECODE_BYTES_PER_POINT,
  getSceneMemoryBudgetBytes,
  LOD_BUILD_BYTES_PER_POINT,
  readLasPointCount,
  TileLoadPipeline,
} from './sceneMemoryBudget';

function lasHeader(minor: number, legacyCount: number, count64?: bigint): ArrayBuffer {
  const size = minor >= 4 ? 375 : 227;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  [0x4c, 0x41, 0x53, 0x46].forEach((byte, i) => view.setUint8(i, byte)); // "LASF"
  view.setUint8(24, 1);
  view.setUint8(25, minor);
  view.setUint16(94, size, true);
  view.setUint32(107, legacyCount, true);
  if (count64 !== undefined) view.setBigUint64(247, count64, true);
  return buffer;
}

describe('readLasPointCount', () => {
  it('reads the 64-bit count of LAS 1.4 (COPC), beyond what 32 bits hold', () => {
    expect(readLasPointCount(lasHeader(4, 0, 55_813_402n))).toBe(55_813_402);
    expect(readLasPointCount(lasHeader(4, 0, 5_000_000_000n))).toBe(5_000_000_000);
  });

  it('falls back to the legacy count (LAS 1.2, or 1.4 writers that leave the 64-bit field empty)', () => {
    expect(readLasPointCount(lasHeader(2, 1_234_567))).toBe(1_234_567);
    expect(readLasPointCount(lasHeader(4, 42, 0n))).toBe(42);
  });

  it('refuses what is not a LAS header', () => {
    expect(readLasPointCount(new ArrayBuffer(400))).toBeNull();
    expect(readLasPointCount(lasHeader(2, 5).slice(0, 100))).toBeNull();
  });
});

describe('getSceneMemoryBudgetBytes', () => {
  it('gives 40 % of the device memory to tiles being loaded, 8 GiB when unknown', () => {
    expect(getSceneMemoryBudgetBytes(8)).toBe(Math.floor(8 * 2 ** 30 * 0.4));
    expect(getSceneMemoryBudgetBytes(undefined)).toBe(getSceneMemoryBudgetBytes(8));
    expect(getSceneMemoryBudgetBytes(16)).toBe(getSceneMemoryBudgetBytes(8));
    expect(getSceneMemoryBudgetBytes(2)).toBe(Math.floor(2 * 2 ** 30 * 0.4));
    expect(getSceneMemoryBudgetBytes(NaN)).toBe(getSceneMemoryBudgetBytes(8));
  });
});

describe('TileLoadPipeline', () => {
  /** Tuiles dont le test termine les deux étapes à la main ; journalise chaque début d'étape. */
  function harness(budgetPoints: number) {
    const pipeline = new TileLoadPipeline(budgetPoints * Math.max(DECODE_BYTES_PER_POINT, LOD_BUILD_BYTES_PER_POINT));
    const log: string[] = [];
    const finishers = new Map<string, () => void>();
    const failers = new Map<string, (error: Error) => void>();
    const stage = (name: string) => new Promise<string>((resolve, reject) => {
      log.push(name);
      finishers.set(name, () => resolve(name));
      failers.set(name, reject);
    });
    const tile = (name: string, points: number) => pipeline.run(points, () => stage(`${name}.decode`), () => stage(`${name}.build`));
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const finish = async (name: string) => {
      finishers.get(name)!();
      await tick();
    };
    const fail = async (name: string) => {
      failers.get(name)!(new Error(`${name} failed`));
      await tick();
    };
    return { pipeline, log, tile, tick, finish, fail };
  }

  it('decodes the next tile while the previous one builds its LOD, one tile per stage', async () => {
    const { log, tile, tick, finish } = harness(100);
    const a = tile('a', 40);
    const b = tile('b', 40);
    const c = tile('c', 10);
    await tick();
    expect(log).toEqual(['a.decode']);
    await finish('a.decode');
    expect(log).toEqual(['a.decode', 'a.build', 'b.decode']);
    await finish('b.decode'); // l'étape de construction est occupée : b attend, et garde c hors de l'étape de décodage
    expect(log).toEqual(['a.decode', 'a.build', 'b.decode']);
    await finish('a.build');
    expect(log).toEqual(['a.decode', 'a.build', 'b.decode', 'b.build', 'c.decode']);
    await finish('c.decode');
    await finish('b.build');
    await finish('c.build');
    await expect(Promise.all([a, b, c])).resolves.toEqual(['a.build', 'b.build', 'c.build']);
  });

  it('waits for the build to finish when both stages would not fit, and keeps arrival order', async () => {
    const { pipeline, log, tile, tick, finish } = harness(100);
    tile('a', 70);
    tile('b', 50);
    tile('c', 5);
    await tick();
    await finish('a.decode');
    expect(log).toEqual(['a.decode', 'a.build']); // 70 + 50 > 100 ; c (5) reste derrière b
    expect(pipeline.held).toBe(70 * LOD_BUILD_BYTES_PER_POINT);
    await finish('a.build');
    expect(log).toEqual(['a.decode', 'a.build', 'b.decode']);
    await finish('b.decode');
    expect(log).toEqual(['a.decode', 'a.build', 'b.decode', 'b.build', 'c.decode']);
    await finish('b.build');
    await finish('c.decode');
    await finish('c.build');
    expect(pipeline.held).toBe(0);
  });

  it('runs a tile heavier than the whole budget alone', async () => {
    const { log, tile, tick, finish } = harness(100);
    tile('small', 10);
    tile('huge', 500);
    await tick();
    await finish('small.decode');
    expect(log).toEqual(['small.decode', 'small.build']);
    await finish('small.build');
    expect(log).toEqual(['small.decode', 'small.build', 'huge.decode']);
    await finish('huge.decode');
    expect(log.at(-1)).toBe('huge.build');
  });

  it('frees the stage and memory of a failed tile', async () => {
    const { pipeline, log, tile, tick, finish, fail } = harness(100);
    const a = expect(tile('a', 60)).rejects.toThrow('a.decode failed');
    const b = expect(tile('b', 60)).rejects.toThrow('b.build failed');
    await tick();
    await fail('a.decode');
    await a;
    expect(log).toEqual(['a.decode', 'b.decode']);
    await finish('b.decode');
    await fail('b.build');
    await b;
    expect(pipeline.held).toBe(0);
  });
});
