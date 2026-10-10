import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TileCoord } from '../types';
import { tileCoordFileName } from './coordConvert';

const coord = { xKm: 965, yKm: 6500, projection: 'LAMB93' } as TileCoord;

/** Un fichier LAS minimal : la signature est tout ce que vérifie saveTile. */
function lasBytes(size = 1024): ArrayBuffer {
  const bytes = new Uint8Array(size);
  bytes.set([0x4c, 0x41, 0x53, 0x46]);
  return bytes.buffer;
}

/** OPFS dont les écritures échouent avec `writeError`, et un storage manager qui enregistre les demandes de persistance. */
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

/** Instances de module neuves : storage garde un état par page (sonde OPFS, demande de persistance). */
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
    // Aucune autre URL n'est essayée : elle retéléchargerait la tuile pour échouer de la même façon.
    expect(errors.isFinalDownloadError(error)).toBe(true);
    // Le fichier écrit en partie n'est pas laissé.
    expect(fake.removed).toEqual([tileCoordFileName(coord)]);
  });

  it('still lets a download succeed when another write error happens', async () => {
    fakeStorage(new Error('disk error'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { archive } = await modules();
    await expect(archive.saveTileQuietly(coord, lasBytes())).resolves.toBeUndefined();
  });

  it('keeps the tile in CacheStorage when OPFS reports a write it did not keep', async () => {
    // Bug WebKit 248719 / Playwright WebKit sous Windows : écriture et fermeture réussissent, le fichier reste vide.
    const files = new Map<string, number>();
    const directory = {
      getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
        if (!files.has(name) && !options?.create) throw new DOMException('absent', 'NotFoundError');
        if (!files.has(name)) files.set(name, 0);
        return {
          createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
          getFile: async () => new Blob([new Uint8Array(files.get(name) ?? 0)]),
        };
      }),
      removeEntry: vi.fn(async (name: string) => {
        files.delete(name);
      }),
    };
    const cached = new Map<string, Response>();
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }), persisted: async () => true },
    });
    vi.stubGlobal('caches', {
      open: async () => ({
        put: async (key: string, response: Response) => {
          cached.set(key, response);
        },
        match: async (key: string) => cached.get(key)?.clone(),
      }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { storage } = await modules();
    const tile = lasBytes(2048);
    await storage.saveTile(coord, tile);
    expect(files.size).toBe(0);
    const loaded = await storage.loadTile(coord);
    expect(loaded?.byteLength).toBe(tile.byteLength);
    expect(await storage.hasTile(coord)).toBe(true);
  });

  it('keeps the CacheStorage copy readable when an OPFS write fails after creating the file', async () => {
    // Fichier tenu par la poignée d'accès synchrone d'un worker : `getFileHandle({ create })` crée le fichier, l'écriture échoue.
    const files = new Map<string, number>();
    const directory = {
      getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
        if (!files.has(name) && !options?.create) throw new DOMException('absent', 'NotFoundError');
        if (!files.has(name)) files.set(name, 0);
        return {
          createWritable: async () => {
            throw new DOMException('locked', 'NoModificationAllowedError');
          },
          getFile: async () => new Blob([new Uint8Array(files.get(name) ?? 0)]),
        };
      }),
      removeEntry: vi.fn(async (name: string) => {
        if (!files.delete(name)) throw new DOMException('absent', 'NotFoundError');
      }),
    };
    const cached = new Map<string, Response>();
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }), persisted: async () => true },
    });
    vi.stubGlobal('caches', {
      open: async () => ({
        put: async (key: string, response: Response) => {
          cached.set(key, response);
        },
        match: async (key: string) => cached.get(key)?.clone(),
        delete: async (key: string) => cached.delete(key),
      }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { storage } = await modules();
    const tile = lasBytes(2048);
    await storage.saveTile(coord, tile);
    // Le fichier vide n'est pas laissé dans l'OPFS.
    expect(files.size).toBe(0);
    expect((await storage.loadTile(coord))?.byteLength).toBe(tile.byteLength);

    // Un fichier OPFS invalide laissé par une version précédente ne supprime que lui : la copie de CacheStorage reste lue.
    files.set(tileCoordFileName(coord), 16);
    expect((await storage.loadTile(coord))?.byteLength).toBe(tile.byteLength);
    expect(files.size).toBe(0);
    expect(cached.size).toBe(1);
  });

  it('fails a download on a full CacheStorage when OPFS is unavailable', async () => {
    // WebKit sous Windows : pas d'OPFS utilisable, les tuiles vont dans CacheStorage.
    vi.stubGlobal('navigator', { storage: { persisted: async () => true } });
    vi.stubGlobal('caches', {
      open: async () => ({
        put: async () => {
          throw new DOMException('quota', 'QuotaExceededError');
        },
        match: async () => undefined,
      }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { storage } = await modules();
    await expect(storage.saveTile(coord, lasBytes())).rejects.toBeInstanceOf(storage.StorageFullError);
    expect(await storage.hasTile(coord)).toBe(false);
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

describe('parseCachedTileName', () => {
  const tiles: TileCoord[] = [
    { xKm: 965, yKm: 6500, territory: 'FXX', projection: 'LAMB93', altRef: 'IGN69' },
    { xKm: 1210, yKm: 6110, territory: 'FXX', projection: 'LAMB93', altRef: 'IGN78' },
    { xKm: 340, yKm: 7650, territory: 'REU', projection: 'RGR92UTM40S', altRef: 'REUN89' },
    { xKm: 2600, yKm: 1200, territory: 'CH', projection: 'CH1903_LV95', altRef: 'LN02' },
    { xKm: 1750, yKm: 5900, territory: 'NZ', projection: 'NZTM2000', altRef: 'NZVD2016', footprint: { minX: 1750000, minY: 5900000, maxX: 1751200, maxY: 5901500 } },
    { xKm: -12, yKm: 5, territory: 'JP', projection: 'JGD2011_ZONE_09', altRef: 'TP', footprint: { minX: -12400, minY: 5000, maxX: -11600, maxY: 5600 } },
    { xKm: 120, yKm: 487, territory: 'NL', projection: 'RD_NEW', altRef: 'NAP' },
    { xKm: 150, yKm: 170, territory: 'BE', projection: 'BL72', altRef: 'TAW' },
  ];

  it('reads back every tile name the cache writes', async () => {
    const { parseCachedTileName } = await import('./storage');
    for (const tile of tiles) {
      const name = tileCoordFileName(tile);
      expect(parseCachedTileName(name, 10, 20), name).toEqual({ coord: tile, fileName: name, sizeBytes: 10, cachedAt: 20 });
    }
  });

  it('ignores any other file of the cache folder', async () => {
    const { parseCachedTileName } = await import('./storage');
    for (const name of [
      'notes.txt',
      'LHD_FXX_0965_6501_PTS_LAMB93_IGN69.copc.laz.tmp',
      'LHD_XXX_0965_6501_PTS_LAMB93_IGN69.copc.laz',
      'LHD_FXX_0965_6501_PTS_WGS84_IGN69.copc.laz',
      'LHD_FXX_0965_6501_PTS_LAMB93_EGM96.copc.laz',
      'LHD_JP_m12_p5_PTS_JGD2011_ZONE_20_TP~-12400,5000,-11600,5600.copc.laz',
      'LHD_NZ_1750_5900_PTS_NZTM2000_NZVD2016~1,2,3.copc.laz',
    ]) {
      expect(parseCachedTileName(name, 1, 1), name).toBeNull();
    }
  });
});
