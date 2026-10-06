import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { canonicalJson } from '../../src/features/itineraryPanel/lib/project/canonicalJson.ts';
import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import type { Itinerary } from '../../src/features/itineraryPanel/types/index.ts';
import { applyCommentAction, type CommentAction } from '../../src/features/comments/lib/commentActions.ts';
import { CollabConnection } from '../../src/features/collab/client/connection.ts';
import { PROTOCOL_VERSION, type MotionCamera, type MotionViewport } from '../../src/features/collab/protocol.ts';
import type { MotionEvent } from '../../src/features/collab/realtime.ts';
import { sampleDocument } from '../../src/features/collab/sim/fixtures.ts';
import { createFileStorage } from './fileStorage.ts';
import { createMultiplayerServer, type MultiplayerServer } from './server.ts';

/**
 * Serveur temps réel réel (HTTP + WebSocket, stockage de fichiers) et vrais
 * clients (`CollabConnection` sur le WebSocket de `ws`) : synchronisation,
 * redémarrage du serveur en pleine édition, modifications faites pendant la
 * connexion, projet supprimé en pleine session, refus d'accès, santé et
 * mesures.
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

const rejections: string[] = [];

function createConnection(user: string, seed?: ProjectDocument): CollabConnection {
  const connection = new CollabConnection({
    url: `ws://127.0.0.1:${port}/multiplayer`,
    projectId: 'local-test',
    getToken: async () => `dev:${user}`,
    seed: () => seed,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    onRejection: (rejection) => rejections.push(`${user}:${rejection.reason}`),
  });
  connections.push(connection);
  return connection;
}

function connect(user: string, seed?: ProjectDocument): CollabConnection {
  const connection = createConnection(user, seed);
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
  rejections.length = 0;
  for (const connection of connections.splice(0)) connection.stop();
  await server?.shutdown();
  server = null;
  await rm(dir, { recursive: true, force: true });
});

describe('serveur temps réel', () => {
  it('santé publique minimale ; mesures sur le port interne seulement', async () => {
    const health = await fetch(`http://127.0.0.1:${port}/multiplayer/health`);
    expect(await health.json()).toEqual({ ok: true });
    expect((await fetch(`http://127.0.0.1:${port}/multiplayer/metrics`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(404);
    const metricsPort = await server!.listenMetrics(0);
    const metrics = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics.json`)).json() as Record<string, number>;
    expect(metrics).toMatchObject({ ok: true, rooms: 0, clients: 0, checkpointErrors: 0 });
    expect(metrics.heap_used_bytes).toBeGreaterThan(0);
    expect(await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text()).toContain('redview_multiplayer_journal_latency_p95_ms');
  });

  it('modification faite pendant la connexion (document du cloud en retard) : arrive chez les autres', async () => {
    const a = connect('alice', sampleDocument(300));
    await waitFor(() => a.client.getState().ready, 'a prêt');
    const cloud = a.client.getDocument();
    edit(a, 'it-2', (it) => ({ ...it, name: 'Après le point de sauvegarde' }));
    await waitFor(() => a.client.getState().unsynced === 0, 'a acquitté');

    // B ouvre le projet : le store se branche sur le document du cloud, la
    // connexion part au branchement ; il renomme avant l'état du serveur.
    const b = createConnection('bob');
    b.client.bind(cloud, []);
    edit(b, 'it-1', (it) => ({ ...it, name: 'Pendant la connexion' }));
    expect(b.client.getState().ready).toBe(false);
    await waitFor(() => itinerary(a, 'it-1').name === 'Pendant la connexion', 'renommage reçu par A');
    await waitFor(() => itinerary(b, 'it-2').name === 'Après le point de sauvegarde', 'état du serveur chez B');
    expect(json(a)).toBe(json(b));
  });

  it('projet supprimé en pleine session : clients refusés (4404), salle fermée et purgée', async () => {
    const a = connect('alice', sampleDocument(200));
    await waitFor(() => a.client.getState().ready, 'a prêt');
    const b = connect('bob');
    await waitFor(() => b.client.getState().ready, 'b prêt');
    await rm(path.join(dir, 'local-test'), { recursive: true, force: true });
    edit(a, 'it-1', (it) => ({ ...it, name: 'Après la suppression' }));
    await waitFor(
      () => a.client.getState().status === 'denied' && b.client.getState().status === 'denied',
      'clients refusés',
    );
    expect(a.client.getState().deniedReason).toBe('not-found');
    expect(server!.host.metrics.deletedRooms).toBe(1);
    expect(server!.host.metrics.checkpointErrors).toBe(0);
    await waitFor(() => server!.host.snapshotMetrics().rooms === 0, 'salle oubliée');
    // La salle est oubliée à la fermeture ; la purge passe après les écritures en cours.
    await waitFor(() => !existsSync(path.join(dir, 'local-test')), 'données purgées');
  });

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

  it('commentaires : fil et réponse croisés, écriture sur le message d’un autre refusée', async () => {
    const a = connect('alice', sampleDocument(200));
    await waitFor(() => a.client.getState().ready, 'a prêt');
    const b = connect('bob');
    await waitFor(() => b.client.getState().ready, 'b prêt');
    const act = (connection: CollabConnection, user: string, action: CommentAction) => {
      const document = connection.client.getDocument();
      const comments = applyCommentAction(document.comments ?? [], action, { userId: user, name: user })!;
      connection.client.pushLocalDocument({ ...document, comments: [...comments] }, 'comment');
    };
    act(a, 'alice', { type: 'create-thread', threadId: 'cm-1', messageId: 'm-1', anchor: { lng: 6.87, lat: 45.92, elevationM: 1000 }, text: 'Col fermé', at: 't0' });
    await waitFor(() => b.client.getDocument().comments?.length === 1, 'fil reçu par B');
    act(b, 'bob', { type: 'reply', threadId: 'cm-1', messageId: 'm-2', text: 'Merci !', at: 't1' });
    await waitFor(() => a.client.getDocument().comments?.[0].messages.length === 2, 'réponse reçue par A');

    // Client modifié : B réécrit le message de A.
    const forged = b.client.getDocument();
    b.client.pushLocalDocument({
      ...forged,
      comments: forged.comments!.map((thread) => ({ ...thread, messages: thread.messages.map((message) => ({ ...message, text: 'Réécrit' })) })),
    }, 'comment');
    await waitFor(() => rejections.includes('bob:comment-not-author'), 'lot refusé');
    await waitFor(() => b.client.getDocument().comments![0].messages[0].text === 'Col fermé', 'B revient à l’état du serveur');
    expect(a.client.getDocument().comments![0].messages.map((message) => message.text)).toEqual(['Col fermé', 'Merci !']);
    expect(json(a)).toBe(json(b));
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

  it('présence en direct : caméra et curseur relayés aux autres, suivi et Spotlight, rien dans le document', async () => {
    const a = connect('alice', sampleDocument(200));
    await waitFor(() => a.client.getState().ready, 'a prêt');
    const b = connect('bob');
    await waitFor(() => b.client.getState().ready, 'b prêt');
    const seqBefore = a.client.engine.seq;
    const atA: MotionEvent[] = [];
    const atB: MotionEvent[] = [];
    a.subscribeMotion((event) => atA.push(event));
    b.subscribeMotion((event) => atB.push(event));

    const cam: MotionCamera = [6.8694, 45.9237, 13.5, -20, 60, 36.87];
    const vp: MotionViewport = [1600, 900, 64, 360, 300, 420, 0, 0, 0, 0];
    expect(a.canSendVolatile()).toBe(true);
    expect(a.sendMotion(100, { cam, vp, ptr: [6.87, 45.92] })).toBe(true);
    await waitFor(() => atB.length === 1, 'motion reçu par B');
    expect(atB[0]).toEqual({ from: a.clientId, t: 100, fields: { cam, vp, ptr: [6.87, 45.92] }, snapshot: false });

    b.updatePresence({ following: a.clientId, spotlight: true });
    await waitFor(() => a.client.getState().peers.some((peer) => peer.clientId === b.clientId && peer.presence.following === a.clientId), 'B suit A');
    const presenceOfB = () => a.client.getState().peers.find((peer) => peer.clientId === b.clientId)!.presence;
    const spotlight = presenceOfB().spotlight!;
    expect(spotlight).toBeGreaterThan(0);
    // Les changements de présence se fusionnent : suivi et Spotlight restent.
    b.updatePresence({ activeItineraryId: 'it-2' });
    await waitFor(() => presenceOfB().activeItineraryId === 'it-2', 'itinéraire actif de B');
    expect(presenceOfB()).toMatchObject({ following: a.clientId, spotlight });

    // Un arrivant part du dernier état de chacun (caméra de départ pour suivre).
    const c = createConnection('carol');
    const atC: MotionEvent[] = [];
    c.subscribeMotion((event) => atC.push(event));
    c.start();
    await waitFor(() => c.client.getState().ready, 'c prêt');
    expect(atC).toEqual([{ from: a.clientId, t: 100, fields: { cam, vp, ptr: [6.87, 45.92] }, snapshot: true }]);

    expect(atA).toHaveLength(0);
    expect(a.client.engine.seq).toBe(seqBefore);
    expect(server!.host.metrics.motionIn).toBe(1);
  });

  it('présence en direct : une rafale au-delà du débit est jetée, la connexion reste ouverte', async () => {
    const a = connect('alice', sampleDocument(100));
    await waitFor(() => a.client.getState().ready, 'a prêt');
    const b = connect('bob');
    await waitFor(() => b.client.getState().ready, 'b prêt');
    let received = 0;
    b.subscribeMotion(() => {
      received += 1;
    });
    for (let index = 0; index < 200; index += 1) a.sendMotion(index, { ptr: [6.87, 45.92] });
    await waitFor(() => server!.host.metrics.motionIn + server!.host.metrics.motionDroppedRate === 200, 'rafale traitée');
    await waitFor(() => received === server!.host.metrics.motionIn, 'relayés reçus');
    expect(received).toBeLessThan(200);
    expect(server!.host.metrics.motionDroppedRate).toBeGreaterThan(0);
    expect(a.client.getState().status).toBe('online');
    // Toujours en ligne : une modification passe.
    edit(a, 'it-1', (it) => ({ ...it, name: 'après la rafale' }));
    await waitFor(() => itinerary(b, 'it-1').name === 'après la rafale', 'modification après la rafale');
  });

  it('refus : version du protocole, jeton invalide', async () => {
    const version = await rawHello({ type: 'hello', v: PROTOCOL_VERSION + 1, projectId: 'local-test', token: 'dev:x', clientId: 'c-1', epoch: null, lastSeq: null });
    expect(version.code).toBe(4426);
    expect((version.message as { code?: string }).code).toBe('version');
    // Onglet resté sur l'ancienne version (sans présence en direct) : refusé, il recharge.
    const previous = await rawHello({ type: 'hello', v: 2, projectId: 'local-test', token: 'dev:x', clientId: 'c-3', epoch: null, lastSeq: null });
    expect(previous.code).toBe(4426);
    const token = await rawHello({ type: 'hello', v: PROTOCOL_VERSION, projectId: 'local-test', token: 'faux', clientId: 'c-2', epoch: null, lastSeq: null });
    expect(token.code).toBe(4401);
    const garbage = await rawHello({ type: 'batch', clientSeq: 1, ops: [], blobs: {} });
    expect(garbage.code).toBe(4400);
  });
});
