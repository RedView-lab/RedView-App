import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import type { Itinerary } from '../../src/features/itineraryPanel/types/index.ts';
import { CollabClient } from '../../src/features/collab/client/collabClient.ts';
import { CollabConnection } from '../../src/features/collab/client/connection.ts';
import { CollabSession } from '../../src/features/collab/client/session.ts';
import { writeUnsynced, type UnsyncedRecord } from '../../src/features/collab/client/unsyncedStore.ts';
import { PROTOCOL_VERSION } from '../../src/features/collab/protocol.ts';
import { sampleDocument } from '../../src/features/collab/sim/fixtures.ts';
import { createFileStorage } from './fileStorage.ts';
import { createMultiplayerServer, type MultiplayerServer } from './server.ts';

/**
 * Copies hors ligne laissées par plusieurs onglets fermés (unsyncedStore.ts) :
 * la session suivante les reprend toutes, dans l'ordre où elles ont été
 * faites (C1-1). Vrai serveur temps réel, vraies sessions (`CollabSession`)
 * sur le WebSocket de `ws`, IndexedDB de fake-indexeddb, Web Locks de Node.
 */

const PROJECT = 'local-test';
let dir: string;
let server: MultiplayerServer | null = null;
let port = 0;
const toStop: Array<{ stop(): unknown }> = [];

globalThis.indexedDB = new IDBFactory();

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'redview-unsynced-'));
  server = createMultiplayerServer({
    storage: createFileStorage(dir),
    appwrite: null,
    devAuth: true,
    host: { journalFlushMs: 20, checkpointIntervalMs: 300, idleUnloadMs: 60_000, log: () => undefined },
  });
  port = await server.listen(0);
});

afterEach(async () => {
  for (const item of toStop.splice(0)) await item.stop();
  await server?.shutdown();
  server = null;
  await rm(dir, { recursive: true, force: true });
});

const connectionOptions = (user: string) => ({
  url: `ws://127.0.0.1:${port}/multiplayer`,
  projectId: PROJECT,
  getToken: async () => `dev:${user}`,
  WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
});

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const itinerary = (document: ProjectDocument, id: string) => (document.itineraries as Itinerary[]).find((it) => it.id === id)!;
const rename = (document: ProjectDocument, id: string, name: string): ProjectDocument => ({
  ...document,
  itineraries: (document.itineraries as Itinerary[]).map((it) => (it.id === id ? { ...it, name } : it)),
} as ProjectDocument);

/** Onglet fermé hors ligne : ses modifications, telles que CollabSession les écrit sur l'appareil. */
function offlineCopy(clientId: string, base: ProjectDocument, renames: Record<string, string>, savedAt: number): UnsyncedRecord {
  const client = new CollabClient({
    clientId,
    transport: { isOnline: () => false, send: () => undefined, requestFlush: () => undefined, resync: () => undefined },
  });
  client.bind(base, []);
  for (const [id, name] of Object.entries(renames)) client.pushLocalDocument(rename(client.getDocument(), id, name), 'user');
  return {
    clientId,
    projectId: PROJECT,
    userId: 'u1',
    protocol: PROTOCOL_VERSION,
    nextClientSeq: client.engine.nextSeq,
    batches: client.engine.unsyncedBatches(),
    savedAt,
  };
}

function storedCopies(): Promise<UnsyncedRecord[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('redview-collab', 1);
    request.onsuccess = () => {
      const get = request.result.transaction('unsynced', 'readonly').objectStore('unsynced').getAll();
      get.onsuccess = () => resolve(get.result as UnsyncedRecord[]);
      get.onerror = () => reject(get.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe('copies hors ligne de plusieurs onglets', () => {
  it('toutes reprises par la session suivante, la plus ancienne d’abord : la plus récente l’emporte (C1-1)', async () => {
    const base = sampleDocument(200);
    const observer = new CollabConnection({ ...connectionOptions('u2'), seed: () => base });
    toStop.push(observer);
    observer.start();
    await waitFor(() => observer.client.getState().ready, 'salle créée');

    // Jour 1, hors ligne : deux onglets du même projet, fermés sans réseau.
    const now = Date.now();
    await writeUnsynced(offlineCopy('onglet-1', base, { 'it-1': 'onglet 1 (ancien)', 'it-2': 'onglet 1' }, now - 60_000));
    await writeUnsynced(offlineCopy('onglet-2', base, { 'it-1': 'onglet 2 (récent)' }, now - 30_000));

    // Jour 2 : un seul onglet ouvre le projet.
    const session = await CollabSession.start({ ...connectionOptions('u1'), userId: 'u1' });
    toStop.push(session);
    session.client.bind(base, []);

    const seen = () => observer.client.getDocument();
    await waitFor(
      () => itinerary(seen(), 'it-2').name === 'onglet 1' && itinerary(seen(), 'it-1').name === 'onglet 2 (récent)',
      'les deux copies arrivent chez les autres',
    );
    await waitFor(() => session.client.engine.fullySynced, 'session écrite');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(itinerary(seen(), 'it-1').name).toBe('onglet 2 (récent)');
    expect(itinerary(session.client.getDocument(), 'it-1').name).toBe('onglet 2 (récent)');
    await session.stop();
    toStop.splice(toStop.indexOf(session), 1);
    // Plus rien à rejouer plus tard par-dessus des modifications plus récentes.
    expect(await storedCopies()).toEqual([]);
  }, 20_000);
});
