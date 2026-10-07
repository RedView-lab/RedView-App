import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LodTile } from '../viewer/lod/lodTile';
import { encodeLodTileIndex, lodCacheKey, saveLodTile } from './lodCache';

const tile: LodTile = {
  header: {
    pointCount: 3,
    nodeCount: 1,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
    origin: { x: 0, y: 0, z: 0 },
    cubeMinX: 0,
    cubeMinY: 0,
    cubeMinZ: 0,
    cubeSize: 1,
    rootSpacing: 1 / 128,
    crs: 'LAMB93',
    embeddedRgb: false,
  },
  nodes: [{ depth: 0, x: 0, y: 0, z: 0, count: 3, byteOffset: 0 }],
  packed: Uint8Array.from({ length: 48 }, (_, i) => i),
};
const expected = new Uint8Array([...encodeLodTileIndex(tile.header, tile.nodes), ...tile.packed]);

/** OPFS directory double: one file, written through a sync access handle or a writable stream. */
function fakeDirectory(mode: 'sync' | 'writable', options: { shortWrite?: boolean } = {}) {
  let bytes = new Uint8Array(0);
  const removed: string[] = [];
  const write = (part: Uint8Array, at: number) => {
    const next = new Uint8Array(Math.max(bytes.length, at + part.length));
    next.set(bytes);
    next.set(part, at);
    bytes = next;
  };
  const handle: Record<string, unknown> = {};
  if (mode === 'sync') {
    handle.createSyncAccessHandle = vi.fn(async () => ({
      truncate: (size: number) => { bytes = bytes.slice(0, size); },
      write: (part: Uint8Array, { at }: { at: number }) => {
        const length = options.shortWrite ? part.length - 1 : part.length;
        write(part.subarray(0, length), at);
        return length;
      },
      flush: vi.fn(),
      close: vi.fn(),
    }));
  }
  handle.createWritable = vi.fn(async () => {
    let at = 0;
    return {
      write: async (part: Uint8Array) => { write(part, at); at += part.length; },
      close: async () => undefined,
      abort: async () => undefined,
    };
  });
  const directory = {
    getFileHandle: vi.fn(async () => handle),
    removeEntry: vi.fn(async (name: string) => { removed.push(name); }),
  };
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) } });
  return { handle, directory, removed, bytes: () => bytes };
}

describe('saveLodTile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes in place through a sync access handle when the worker has one', async () => {
    const fake = fakeDirectory('sync');
    await expect(saveLodTile('tile.copc.laz', tile)).resolves.toBe(true);
    expect(fake.handle.createSyncAccessHandle).toHaveBeenCalledOnce();
    expect(fake.handle.createWritable).not.toHaveBeenCalled();
    expect(fake.bytes()).toEqual(expected);
    expect(fake.directory.getFileHandle).toHaveBeenCalledWith(lodCacheKey('tile.copc.laz'), { create: true });
  });

  it('falls back to a writable stream elsewhere, same bytes', async () => {
    const fake = fakeDirectory('writable');
    await expect(saveLodTile('tile.copc.laz', tile)).resolves.toBe(true);
    expect(fake.bytes()).toEqual(expected);
  });

  it('drops a partly written file', async () => {
    const fake = fakeDirectory('sync', { shortWrite: true });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(saveLodTile('tile.copc.laz', tile)).resolves.toBe(false);
    expect(fake.removed).toEqual([lodCacheKey('tile.copc.laz')]);
  });
});
