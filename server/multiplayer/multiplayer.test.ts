import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { canonicalJson } from '../../src/features/itineraryPanel/lib/project/canonicalJson.ts';
import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import type { Itinerary } from '../../src/features/itineraryPanel/types/index.ts';
import { CollabConnection } from '../../src/features/collab/client/connection.ts';
import { PROTOCOL_VERSION } from '../../src/features/collab/protocol.ts';
import { sampleDocument } from '../../src/features/collab/sim/fixtures.ts';
import { createFileStorage } from './fileStorage.ts';
import { createMultiplayerServer, type MultiplayerServer } from './server.ts';

/**
 * Serveur temps réel réel (HTTP + WebSocket, stockage de fichiers) et vrais
 * clients (`CollabConnection` sur le WebSocket de `ws`) : synchronisation,
 * redémarrage du serveur en pleine édition, refus d'accès.
 */

let dir: string;
let server: MultiplayerServer | null = null;
let port = 0;
const connections: CollabConnection[] = [];

async function start(): Promise<void> {
  server = createMultiplayerServer({
    storage: createFileStorage(dir),
    appwrite: null,
    devAuth: true,
    host: { journalFlushMs: 20, checkpointIntervalMs: 300, idleUnloadMs: 60_000, log: () => undefined },
  });
  port = await server.listen(port);
}

function connect(user: string, seed?: ProjectDocument): CollabConnection {
  const connection = new CollabConnection({
    url: `ws://127.0.0.1:${port}/multiplayer`,
    projectId: 'local-test',
    getToken: async () => `dev:${user}`,
    seed: () => seed,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  connections.push(connection);
  connection.start();
  return connection;
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const json = (connection: CollabConnection) => canonicalJson(connection.client.getDocument());
const itinerary = (connection: CollabConnection, id: string) =>
  (connection.client.getDocument().itineraries as Itinerary[]).find((it) => it.id === id)!;

function edit(connection: CollabConnection, id: string, update: (it: Itinerary) => Itinerary): void {
  const document = connection.client.getDocument();
  connection.client.pushLocalDocument({
    ...document,
    itineraries: (document.itineraries as Itinerary[]).map((it) => (it.id === id ? update(it) : it)),
  } as ProjectDocument, 'step');
}

/** Message brut au serveur ; renvoie le premier message et le code de fermeture. */
function rawHello(hello: Record<string, unknown>): Promise<{ message: unknown; code: number }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/multiplayer`);
    let message: unknown = null;
    socket.on('open', () => socket.send(JSON.stringify(hello)));
    socket.on('message', (data) => {
      message ??= JSON.parse(String(data));
    });
    socket.on('close', (code) => resolve({ message, code }));
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'redview-mp-'));
  port = 0;
  await start();
});

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.stop();
  await server?.shutdown();
  server = null;
  await rm(dir, { recursive: true, force: true });
});

describe('serveur temps réel', () => {
  it('deux clients : état initial, modifications croisées, convergence', async () => {
    const a = connect('alice', sampleDocument(500));
    await waitFor(() => a.client.getState().ready, 'a prêt');
    const b = connect('bob');
    await waitFor(() => b.client.getState().ready, 'b prêt');
    expect(json(b)).toBe(json(a));

    edit(a, 'it-1', (it) => ({ ...it, name: 'Alice' }));
    edit(b, 'it-2', (it) => ({ ...it, color: '#3d8bff' }));
    await waitFor(() => itinerary(b, 'it-1').name === 'Alice' && itinerary(a, 'it-2').color === '#3d8bff', 'convergence');
    expect(json(a)).toBe(json(b));
    await waitFor(() => a.client.getState().peers.length === 2, 'présence');
  });

  it('redémarrage du serveur en pleine édition : rien n’est perdu', async () => {
    const a = connect('alice', sampleDocument(300));
    await waitFor(() => a.client.getState().ready, 'a prêt');
    const b = connect('bob');
    await waitFor(() => b.client.getState().ready, 'b prêt');

    edit(a, 'it-1', (it) => ({ ...it, name: 'avant arrêt' }));
    await waitFor(() => itinerary(b, 'it-1').name === 'avant arrêt', 'propagation');

    await server!.shutdown();
    server = null;
    await waitFor(() => a.client.getState().status !== 'online' && b.client.getState().status !== 'online', 'clients hors ligne');
    // Modifications pendant la coupure : gardées et renvoyées.
    edit(a, 'it-2', (it) => ({ ...it, name: 'hors ligne A' }));
    edit(b, 'it-1', (it) => ({ ...it, color: '#22aa55' }));

    await start();
    await waitFor(() => a.client.getState().status === 'online' && b.client.getState().status === 'online', 'reconnexion', 15_000);
    await waitFor(
      () => itinerary(b, 'it-2').name === 'hors ligne A' && itinerary(a, 'it-1').color === '#22aa55'
        && a.client.getState().unsynced === 0 && b.client.getState().unsynced === 0,
      'convergence après reconnexion',
      15_000,
    );
    expect(json(a)).toBe(json(b));
    expect(itinerary(a, 'it-1').name).toBe('avant arrêt');

    // Un nouveau client relit l'état depuis le stockage (point de sauvegarde + journal).
    await server!.shutdown();
    server = null;
    for (const connection of connections.splice(0)) connection.stop();
    await start();
    const c = connect('carol');
    await waitFor(() => c.client.getState().ready, 'c prêt');
    expect(itinerary(c, 'it-2').name).toBe('hors ligne A');
    expect(itinerary(c, 'it-1').color).toBe('#22aa55');
  });

  it('refus : version du protocole, jeton invalide', async () => {
    const version = await rawHello({ type: 'hello', v: PROTOCOL_VERSION + 1, projectId: 'local-test', token: 'dev:x', clientId: 'c-1', epoch: null, lastSeq: null });
    expect(version.code).toBe(4426);
    expect((version.message as { code?: string }).code).toBe('version');
    const token = await rawHello({ type: 'hello', v: PROTOCOL_VERSION, projectId: 'local-test', token: 'faux', clientId: 'c-2', epoch: null, lastSeq: null });
    expect(token.code).toBe(4401);
    const garbage = await rawHello({ type: 'batch', clientSeq: 1, ops: [], blobs: {} });
    expect(garbage.code).toBe(4400);
  });
});
