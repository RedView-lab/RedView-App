import { describe, expect, it } from 'vitest';
import { FIRST_LOAD_BYTES_PER_POINT, getScenePointBudget, PointBudgetGate, readLasPointCount } from './sceneMemoryBudget';

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

describe('getScenePointBudget', () => {
  it('gives 40 % of the device memory to decoded tiles, 8 GiB when unknown', () => {
    expect(getScenePointBudget(8)).toBe(Math.floor((8 * 2 ** 30 * 0.4) / FIRST_LOAD_BYTES_PER_POINT));
    expect(getScenePointBudget(undefined)).toBe(getScenePointBudget(8));
    expect(getScenePointBudget(2)).toBe(Math.floor((2 * 2 ** 30 * 0.4) / FIRST_LOAD_BYTES_PER_POINT));
    expect(getScenePointBudget(NaN)).toBe(getScenePointBudget(8));
  });
});

describe('PointBudgetGate', () => {
  /** A task the test finishes by hand; records the tasks running with it. */
  function controlled() {
    const log: string[] = [];
    const done = new Map<string, () => void>();
    const start = (gate: PointBudgetGate, name: string, weight: number) => gate.run(weight, (running) => {
      log.push(`${name}:${running}`);
      return new Promise<string>((resolve) => done.set(name, () => resolve(name)));
    });
    const finish = async (name: string) => {
      done.get(name)!();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { log, start, finish };
  }

  it('runs tasks together while their weights fit, then in arrival order', async () => {
    const gate = new PointBudgetGate(100);
    const { log, start, finish } = controlled();
    const a = start(gate, 'a', 60);
    const b = start(gate, 'b', 30);
    const c = start(gate, 'c', 50); // does not fit next to a + b
    const d = start(gate, 'd', 5); // would fit, but waits behind c (no starvation)
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['a:1', 'b:2']);
    await finish('a');
    expect(log).toEqual(['a:1', 'b:2', 'c:2', 'd:3']);
    await finish('b');
    await finish('c');
    await finish('d');
    await expect(Promise.all([a, b, c, d])).resolves.toEqual(['a', 'b', 'c', 'd']);
  });

  it('runs a task heavier than the whole budget alone', async () => {
    const gate = new PointBudgetGate(100);
    const { log, start, finish } = controlled();
    start(gate, 'small', 10);
    start(gate, 'huge', 500);
    start(gate, 'after', 10);
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['small:1']);
    await finish('small');
    expect(log).toEqual(['small:1', 'huge:1']);
    await finish('huge');
    expect(log).toEqual(['small:1', 'huge:1', 'after:1']);
  });

  it('frees the budget of a failed task', async () => {
    const gate = new PointBudgetGate(100);
    await expect(gate.run(90, () => Promise.reject(new Error('decode failed')))).rejects.toThrow('decode failed');
    await expect(gate.run(90, (running) => Promise.resolve(running))).resolves.toBe(1);
  });
});
