import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import type { Itinerary } from '../../src/features/itineraryPanel/types/index.ts';
import { CollabConnection } from '../../src/features/collab/client/connection.ts';
import { PROTOCOL_VERSION } from '../../src/features/collab/protocol.ts';
import { sampleDocument } from '../../src/features/collab/sim/fixtures.ts';
import { createFileStorage } from './fileStorage.ts';
import { createMultiplayerServer, type MultiplayerServer } from './server.ts';

/**
 * Cas limites du serveur temps réel et de sa connexion, sur le vrai serveur
 * (HTTP + WebSocket, stockage de fichiers) : longue édition hors ligne
 * renvoyée à la reconnexion, connexion d'un client remplacée par une
 * nouvelle (réseau changé, l'ancienne pas encore tombée).
 */

let dir: string;
let server: MultiplayerServer | null = null;
let port = 0;
const connections: CollabConnection[] = [];
const closeCodes: number[] = [];

async function start(): Promise<void> {
  server = createMultiplayerServer({
    storage: createFileStorage(dir),
    appwrite: null,
    devAuth: true,
    host: { journalFlushMs: 20, checkpointIntervalMs: 300, idleUnloadMs: 60_000, log: () => undefined },
  });
  port = await server.listen(port);
}

/** WebSocket de `ws` qui note les codes de fermeture vus par le client. */
class RecordingWebSocket extends WebSocket {
  constructor(url: string) {
    super(url);
    this.addEventListener('close', (event) => closeCodes.push(event.code));
  }
}

function connect(user: string, seed?: ProjectDocument): CollabConnection {
  const connection = new CollabConnection({
    url: `ws://127.0.0.1:${port}/multiplayer`,
    projectId: 'local-test',
    getToken: async () => `dev:${user}`,
    seed: () => seed,
    WebSocketImpl: RecordingWebSocket as unknown as typeof globalThis.WebSocket,
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

const itinerary = (connection: CollabConnection, id: string) =>
  (connection.client.getDocument().itineraries as Itinerary[]).find((it) => it.id === id)!;

function edit(connection: CollabConnection, id: string, update: (it: Itinerary) => Itinerary): void {
  const document = connection.client.getDocument();
  connection.client.pushLocalDocument({
    ...document,
    itineraries: (document.itineraries as Itinerary[]).map((it) => (it.id === id ? update(it) : it)),
  } as ProjectDocument, 'step');
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'redview-mp-robust-'));
  port = 0;
  closeCodes.length = 0;
  await start();
});

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.stop();
  await server?.shutdown();
  server = null;
  await rm(dir, { recursive: true, force: true });
});

describe('serveur temps réel : cas limites', () => {
  it('longue édition hors ligne (milliers de modifications) : tout passe à la reconnexion, sans refus pour débit', async () => {
    const a = connect('alice', sampleDocument(100));
    await waitFor(() => a.client.getState().ready, 'a prêt');
    await server!.shutdown();
    server = null;
    await waitFor(() => a.client.getState().status !== 'online', 'hors ligne');

    // Un glisser continu pendant la coupure : une écriture par image (~ 30 Hz), chacune scellée.
    const EDITS = 3_000;
    for (let index = 1; index <= EDITS; index += 1) {
      edit(a, 'it-1', (it) => ({ ...it, name: `hors ligne ${index}` }));
      a.client.flush();
    }

    await start();
    await waitFor(() => a.client.getState().status === 'online', 'reconnexion', 15_000);
    await waitFor(() => a.client.getState().unsynced === 0, 'tout acquitté', 20_000);
    const b = connect('bob');
    await waitFor(() => b.client.getState().ready, 'b prêt');
    expect(itinerary(b, 'it-1').name).toBe(`hors ligne ${EDITS}`);
    expect(closeCodes).not.toContain(4429);
  }, 40_000);

  it('même client sur une nouvelle connexion : l’ancienne est fermée et ses messages ignorés', async () => {
    const a = connect('alice', sampleDocument(50));
    await waitFor(() => a.client.getState().ready, 'a prêt');
    const clientId = a.clientId;
    a.stop();

    // Deux connexions brutes du même client : la première n'est pas fermée côté client (réseau changé).
    const open = () => new Promise<{ socket: WebSocket; messages: Array<Record<string, unknown>>; closed: Promise<number> }>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/multiplayer`);
      const messages: Array<Record<string, unknown>> = [];
      const closed = new Promise<number>((done) => socket.on('close', (code) => done(code)));
      socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, projectId: 'local-test', token: 'dev:alice', clientId, epoch: null, lastSeq: null })));
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        messages.push(message);
        if (message.type === 'welcome') resolve({ socket, messages, closed });
      });
    });
    const first = await open();
    const second = await open();
    // L'ancienne connexion est fermée par le serveur (plus de connexion fantôme jusqu'au battement de cœur).
    expect(await first.closed).toBe(4409);
    // La nouvelle reste ouverte et sert le client.
    second.socket.send(JSON.stringify({ type: 'ping', t: 42 }));
    await waitFor(() => second.messages.some((message) => message.type === 'pong'), 'pong sur la nouvelle connexion');
    second.socket.close();
  });
});
