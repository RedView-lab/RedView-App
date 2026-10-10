import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UnsyncedRecord } from './unsyncedStore';

/**
 * Copies de co-édition non envoyées (IndexedDB `redview-collab`) à la
 * suppression d'un compte : seules les siennes partent, la base disparaît
 * quand plus rien n'y reste, et n'est jamais créée pour rien (B3-3).
 */

async function load() {
  vi.resetModules();
  return import('./unsyncedStore');
}

const record = (clientId: string, userId: string): UnsyncedRecord => ({
  clientId, projectId: 'p1', userId, protocol: 4, nextClientSeq: 2, batches: [], savedAt: Date.now(),
});

const databaseNames = async () => (await indexedDB.databases()).map((db) => db.name);

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

describe('deleteUnsyncedOfUser', () => {
  it('efface les copies du compte, garde celles d’un autre, puis la base quand elle est vide', async () => {
    const store = await load();
    await store.writeUnsynced(record('c-alice', 'alice'));
    await store.writeUnsynced(record('c-bob', 'bob'));

    await store.deleteUnsyncedOfUser('bob');
    expect(await databaseNames()).toContain('redview-collab');

    await store.deleteUnsyncedOfUser('alice');
    expect(await databaseNames()).not.toContain('redview-collab');
  });

  it('n’ouvre (donc ne crée) jamais une base absente', async () => {
    const store = await load();
    await store.deleteUnsyncedOfUser('alice');
    expect(await databaseNames()).not.toContain('redview-collab');
  });
});
