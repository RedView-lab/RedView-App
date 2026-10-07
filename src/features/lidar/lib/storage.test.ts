import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TileCoord } from '../types';
import { tileCoordFileName } from './coordConvert';

const coord = { xKm: 965, yKm: 6500, projection: 'LAMB93' } as TileCoord;

/** A minimal LAS file: the signature is all saveTile checks. */
function lasBytes(size = 1024): ArrayBuffer {
  const bytes = new Uint8Array(size);
  bytes.set([0x4c, 0x41, 0x53, 0x46]);
  return bytes.buffer;
}

/** OPFS whose writes fail with `writeError`, and a storage manager recording persistence requests. */
function fakeStorage(writeError: unknown) {
  const removed: string[] = [];
  const persist = vi.fn(async () => true);
  const directory = {
    getFileHandle: vi.fn(async () => ({
      createWritable: async () => ({
        write: async () => {
          throw writeError;
        },
        close: async () => undefined,
      }),
    })),
    removeEntry: vi.fn(async (name: string) => {
      removed.push(name);
    }),
  };
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({ getDirectoryHandle: async () => directory }),
      persisted: async () => false,
      persist,
    },
  });
  return { removed, persist };
}

/** Fresh module instances: storage keeps per-page state (OPFS probe, persistence request). */
async function modules() {
  vi.resetModules();
  return {
    storage: await import('./storage'),
    archive: await import('./download/archiveCandidates'),
    errors: await import('./download/errors'),
  };
}

describe('LiDAR tile storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails a download on a full storage instead of keeping the tile in this page memory', async () => {
    const fake = fakeStorage(new DOMException('quota', 'QuotaExceededError'));
    const { storage, archive, errors } = await modules();
    const error = await archive.saveTileQuietly(coord, lasBytes()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(storage.StorageFullError);
    // No other URL is tried: it would download the tile again to fail the same way.
    expect(errors.isFinalDownloadError(error)).toBe(true);
    // The partly written file is not left behind.
    expect(fake.removed).toEqual([tileCoordFileName(coord)]);
  });

  it('still lets a download succeed when another write error happens', async () => {
    fakeStorage(new Error('disk error'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { archive } = await modules();
    await expect(archive.saveTileQuietly(coord, lasBytes())).resolves.toBeUndefined();
  });

  it('asks once per page for persistent storage when tiles are stored', async () => {
    const fake = fakeStorage(new Error('disk error'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { storage } = await modules();
    await storage.saveTile(coord, lasBytes()).catch(() => undefined);
    await storage.saveTile(coord, lasBytes()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.persist).toHaveBeenCalledOnce();
  });
});
