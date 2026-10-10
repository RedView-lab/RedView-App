import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { routeChunkId } from '../../src/features/collab/routeChunks.ts';
import { PROTOCOL_VERSION, SOCKET_PROTOCOL, socketProtocols, type ServerMessage } from '../../src/features/collab/protocol.ts';
import { sampleDocument } from '../../src/features/collab/sim/fixtures.ts';
import type { Authenticator, Identity } from './auth.ts';
import { createFileStorage } from './fileStorage.ts';
import { createMultiplayerServer, type MultiplayerServer, type MultiplayerServerOptions } from './server.ts';

/**
 * Sécurité du serveur temps réel, de bout en bout (vrai serveur, vrais
 * clients `ws` bruts) : rien n'est lu d'une connexion avant que son jeton et
 * ses droits soient vérifiés, l'origine et les plafonds sont tenus, un lot
 * hostile est refusé sans faire tomber le serveur, une exception ne ferme que
 * sa salle, un `clientId` ne se vole pas, un jeton expiré sans relève ferme la
 * connexion, un retrait d'accès signalé par l'API de partage s'applique tout
 * de suite, le nom affiché est celui du compte.
 */

const PROJECT = 'proj-secu';
const SECRET = 's'.repeat(40);

/** Comptes de test : jeton → identité ; droits par utilisateur (modifiables en cours de test). */
const identities = new Map<string, Identity>();
const access = new Map<string, 'ok' | 'forbidden' | 'not-found'>();

const fakeAuth: Authenticator = {
  async verifyToken(token) {
    return identities.get(token) ?? null;
  },
  async checkAccess(userId) {
    return access.get(userId) ?? 'forbidden';
  },
  forgetProject() {},
};

let dir: string;
let server: MultiplayerServer | null = null;
let port = 0;
const sockets: WebSocket[] = [];

async function start(overrides: Partial<MultiplayerServerOptions> = {}): Promise<void> {
  server = createMultiplayerServer({
    storage: createFileStorage(dir),
    appwrite: null,
    devAuth: true,
    authenticator: fakeAuth,
    allowedOrigins: ['https://app.redview.tech'],
    internalSecret: SECRET,
    host: { journalFlushMs: 20, checkpointIntervalMs: 300, idleUnloadMs: 60_000, log: () => undefined },
    ...overrides,
  });
  port = await server.listen(0, '127.0.0.1');
}

interface Raw {
  socket: WebSocket;
  messages: ServerMessage[];
  closed: Promise<number>;
  /** Réponse HTTP d'un refus avant WebSocket (origine, plafond), sinon null. */
  httpStatus: Promise<number | null>;
}

function open(token: string, { protocols, origin, project = PROJECT }: { protocols?: string[]; origin?: string; project?: string } = {}): Raw {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/multiplayer?project=${project}`, protocols ?? socketProtocols(token), origin ? { origin } : {});
  sockets.push(socket);
  const messages: ServerMessage[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
  socket.on('error', () => undefined);
  const httpStatus = new Promise<number | null>((resolve) => {
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.on('open', () => resolve(null));
    socket.on('close', () => resolve(null));
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  return { socket, messages, closed, httpStatus };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Connexion acceptée, `hello` envoyé, `welcome` reçu. */
async function join(token: string, clientId: string, presence: Record<string, unknown> = {}): Promise<Raw> {
  const raw = open(token);
  await new Promise<void>((resolve, reject) => {
    raw.socket.on('open', () => resolve());
    raw.socket.on('close', (code) => reject(new Error(`fermée ${code}`)));
  });
  raw.socket.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, clientId, epoch: null, lastSeq: null, presence, seed: sampleDocument(50) }));
  await waitFor(() => raw.messages.some((message) => message.type === 'welcome'), `welcome de ${clientId}`);
  return raw;
}

const send = (raw: Raw, message: unknown) => raw.socket.send(JSON.stringify(message));
const healthy = async () => (await (await fetch(`http://127.0.0.1:${port}/multiplayer/health`)).json()) as { ok: boolean };

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'redview-mp-secu-'));
  identities.clear();
  access.clear();
  for (const [token, userId, name] of [['tok-alice', 'alice', 'Alice Vraie'], ['tok-bob', 'bob', 'Bob'], ['tok-carol', 'carol', 'Carol']]) {
    identities.set(token, { userId, name, expiresAt: Date.now() + 15 * 60_000 });
    access.set(userId, 'ok');
  }
  await start();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.shutdown();
  server = null;
  await rm(dir, { recursive: true, force: true });
});

describe('serveur temps réel : ouverture des connexions', () => {
  it('jeton absent, faux, ancienne version, accès refusé ou projet introuvable : fermée avec son code, rien de lu', async () => {
    expect(await open('', { protocols: [SOCKET_PROTOCOL] }).closed).toBe(4400);
    expect(await open('tok-inconnu').closed).toBe(4401);
    expect(await open('tok-alice', { protocols: [] }).closed).toBe(4426);
    expect(await open('tok-alice', { project: '../../etc' }).closed).toBe(4400);
    access.set('alice', 'forbidden');
    expect(await open('tok-alice').closed).toBe(4403);
    access.set('alice', 'not-found');
    expect(await open('tok-alice').closed).toBe(4404);
    expect(server!.host.metrics.connectionsRefused).toBeGreaterThanOrEqual(6);
  });

  it('droits lus pendant la vérification du jeton : seulement pour le même utilisateur, jamais attendus par un refus', async () => {
    // Jetons dont la charge (non vérifiée) déclare alice, qui a accès.
    const claims = new Map([['tok-eve', 'alice'], ['tok-forge', 'alice']]);
    identities.set('tok-eve', { userId: 'eve', expiresAt: Date.now() + 15 * 60_000 });
    access.set('eve', 'forbidden');
    const checked: string[] = [];
    let slowFor: string | null = null;
    await server!.shutdown();
    await start({
      authenticator: {
        ...fakeAuth,
        claimedUserId: (token) => claims.get(token) ?? identities.get(token)?.userId ?? null,
        async checkAccess(userId, projectId, options) {
          checked.push(userId);
          if (userId === slowFor) await new Promise((resolve) => setTimeout(resolve, 3_000));
          return fakeAuth.checkAccess(userId, projectId, options);
        },
      },
    });
    // Le jeton d'eve déclare alice : la décision porte sur eve (vérifiée), refusée.
    expect(await open('tok-eve').closed).toBe(4403);
    expect(checked).toEqual(['alice', 'eve']);
    // Jeton refusé dont l'utilisateur déclaré a des droits lents à lire : refusé sans les attendre.
    slowFor = 'alice';
    const started = Date.now();
    expect(await open('tok-forge').closed).toBe(4401);
    expect(Date.now() - started).toBeLessThan(1_500);
    // Jeton valide : les droits ne sont lus qu'une fois.
    slowFor = null;
    checked.length = 0;
    await join('tok-bob', 'bob-1');
    expect(checked).toEqual(['bob']);
  });

  it('connexion refusée qui envoie quand même un gros message : rien n’est lu, le serveur reste debout', async () => {
    const raw = open('tok-inconnu');
    raw.socket.on('open', () => raw.socket.send('x'.repeat(200_000)));
    expect(await raw.closed).not.toBe(1000);
    expect(await healthy()).toEqual({ ok: true });
  });

  it('origine étrangère (page d’un autre site) : refusée avant toute WebSocket ; la bonne origine et l’absence d’origine passent', async () => {
    expect(await open('tok-alice', { origin: 'https://evil.example' }).httpStatus).toBe(403);
    expect(await open('tok-alice', { origin: 'null' }).httpStatus).toBe(403);
    const good = open('tok-alice', { origin: 'https://app.redview.tech' });
    expect(await good.httpStatus).toBeNull();
    expect(good.socket.protocol).toBe(SOCKET_PROTOCOL);
  });

  it('plafonds : connexions par IP, par utilisateur', async () => {
    await server!.shutdown();
    await start({ limits: { perIp: 3, perUser: 2 } });
    const a1 = await join('tok-alice', 'a1');
    await join('tok-alice', 'a2');
    // Troisième connexion d'Alice : trop pour un utilisateur.
    expect(await open('tok-alice').closed).toBe(1013);
    await join('tok-bob', 'b1');
    // Quatrième connexion depuis la même IP.
    expect(await open('tok-carol').httpStatus).toBe(429);
    // Une place se libère (dès que le serveur a vu la fermeture) : on repasse.
    a1.socket.close();
    await a1.closed;
    const deadline = Date.now() + 5_000;
    for (;;) {
      const retry = open('tok-carol');
      if ((await retry.httpStatus) === null) break;
      if (Date.now() > deadline) throw new Error('place jamais libérée');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
});

describe('serveur temps réel : messages hostiles', () => {
  it('lots hostiles refusés, serveur et salle toujours debout', async () => {
    const alice = await join('tok-alice', 'a1');
    const bob = await join('tok-bob', 'b1');
    const json = '[{"lat":1,"lon":2}],"injecte":{"x":1},"y":[{"lat":3,"lon":4}]';
    const hostile = [
      [{ t: 'd', id: 'p' }],
      [{ t: 's', id: 'p', k: '__proto__', v: { polluted: true } }],
      [{ t: 's', id: 'p/itineraries:it-1', k: 'nam%65', v: 'x' }],
      [{ t: 's', id: 'p/itineraries:it-1', k: 'gpxRoute', v: { v: 1, meta: {}, points: [routeChunkId(json)] } }],
    ];
    hostile.forEach((ops, index) => send(bob, { type: 'batch', clientSeq: index + 1, ops, blobs: index === 3 ? { [routeChunkId(json)]: json } : {} }));
    await waitFor(() => bob.messages.filter((message) => message.type === 'reject').length === hostile.length, 'refus');
    expect(({}) as Record<string, unknown>).not.toHaveProperty('polluted');
    // La salle sert toujours : un lot honnête passe chez l'autre.
    send(bob, { type: 'batch', clientSeq: 10, ops: [{ t: 's', id: 'p/itineraries:it-1', k: 'name', v: 'Honnête' }], blobs: {} });
    await waitFor(() => alice.messages.some((message) => message.type === 'batch' && message.batch.clientSeq === 10), 'lot honnête relayé');
    expect(await healthy()).toEqual({ ok: true });
  });

  it('exception pendant le traitement d’un message : seule la salle est fermée (1011), puis rechargée', async () => {
    const alice = await join('tok-alice', 'a1');
    const room = (await server!.host.open(PROJECT))!;
    room.room.handle = () => {
      throw new Error('panne simulée');
    };
    send(alice, { type: 'ping', t: 1 });
    expect(await alice.closed).toBe(1011);
    expect(server!.host.metrics.roomFailures).toBe(1);
    expect(await healthy()).toEqual({ ok: true });
    const again = await join('tok-alice', 'a2');
    expect(again.messages.find((message) => message.type === 'welcome')).toBeDefined();
  });

  it('`clientId` d’un autre éditeur : connexion refusée, le titulaire n’est pas éjecté', async () => {
    const alice = await join('tok-alice', 'shared-id');
    const bob = open('tok-bob');
    await new Promise((resolve) => bob.socket.on('open', resolve));
    send(bob, { type: 'hello', v: PROTOCOL_VERSION, clientId: 'shared-id', epoch: null, lastSeq: null });
    expect(await bob.closed).toBe(4400);
    send(alice, { type: 'ping', t: 7 });
    await waitFor(() => alice.messages.some((message) => message.type === 'pong'), 'alice toujours connectée');
  });

  it('nom affiché : celui du compte, pas celui que le client met dans sa présence', async () => {
    const alice = await join('tok-alice', 'a1', { name: 'Usurpateur' });
    await join('tok-bob', 'b1', { name: 'Bob' });
    await waitFor(() => alice.messages.some((message) => message.type === 'peers' && message.peers.length === 2), 'présence');
    const peers = [...alice.messages].reverse().find((message) => message.type === 'peers') as Extract<ServerMessage, { type: 'peers' }>;
    expect(peers.peers.find((peer) => peer.userId === 'alice')?.presence.name).toBe('Alice Vraie');
  });
});

describe('serveur temps réel : jeton et droits pendant la session', () => {
  it('jeton expiré sans relève : fermée (4401) ; relevé par le même utilisateur : gardée ; par un autre : fermée', async () => {
    await server!.shutdown();
    await start({ timings: { accessRecheckMs: 50, tokenGraceMs: 0 } });
    // Délais larges : la machine peut être chargée (porte de qualité en parallèle).
    const keptExpiry = Date.now() + 2_000;
    identities.set('tok-moyen', { userId: 'alice', name: 'Alice', expiresAt: keptExpiry });
    identities.set('tok-relève', { userId: 'alice', name: 'Alice', expiresAt: Date.now() + 60_000 });
    const kept = await join('tok-moyen', 'a1');
    send(kept, { type: 'auth', token: 'tok-relève' });
    identities.set('tok-court', { userId: 'alice', name: 'Alice', expiresAt: Date.now() + 200 });
    const expired = await join('tok-court', 'a2');
    expect(await expired.closed).toBe(4401);
    // Au-delà de l'expiration du premier jeton de `kept` : la relève l'a gardée ouverte.
    await waitFor(() => Date.now() > keptExpiry + 300, 'expiration du premier jeton', 5_000);
    expect(kept.socket.readyState).toBe(WebSocket.OPEN);
    send(kept, { type: 'auth', token: 'tok-bob' });
    expect(await kept.closed).toBe(4401);
  });

  it('retrait signalé par l’API de partage (signé) : éditeur fermé tout de suite (4403) ; signature fausse : refusée', async () => {
    const bob = await join('tok-bob', 'b1');
    access.set('bob', 'forbidden');
    const body = JSON.stringify({ projectId: PROJECT, ts: Date.now() });
    const post = (signature: string) => fetch(`http://127.0.0.1:${port}/multiplayer/internal/access-changed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-redview-signature': signature },
      body,
    });
    expect((await post('0'.repeat(64))).status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bob.socket.readyState).toBe(WebSocket.OPEN);
    expect((await post(createHmac('sha256', SECRET).update(body).digest('hex'))).status).toBe(204);
    expect(await bob.closed).toBe(4403);
    // Message trop vieux (rejoué) : refusé.
    const old = JSON.stringify({ projectId: PROJECT, ts: Date.now() - 10 * 60_000 });
    const replay = await fetch(`http://127.0.0.1:${port}/internal/access-changed`, {
      method: 'POST',
      headers: { 'x-redview-signature': createHmac('sha256', SECRET).update(old).digest('hex') },
      body: old,
    });
    expect(replay.status).toBe(400);
  });

  it('une IP qui inonde la route de révocation ne bloque pas les vraies révocations (quota par IP, A6-1)', { timeout: 30_000 }, async () => {
    const bob = await join('tok-bob', 'b1');
    const attempt = (forwardedFor: string, body: string, signature: string) => fetch(`http://127.0.0.1:${port}/multiplayer/internal/access-changed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-redview-signature': signature, 'x-forwarded-for': forwardedFor },
      body,
    });
    let limited = false;
    for (let index = 0; index < 320 && !limited; index += 1) {
      limited = (await attempt('203.0.113.9', '{}', '0'.repeat(64))).status === 429;
    }
    expect(limited).toBe(true);
    access.set('bob', 'forbidden');
    const body = JSON.stringify({ projectId: PROJECT, ts: Date.now() });
    expect((await attempt('198.51.100.20', body, createHmac('sha256', SECRET).update(body).digest('hex'))).status).toBe(204);
    expect(await bob.closed).toBe(4403);
  });

  it('sans secret configuré, la route de révocation n’existe pas', async () => {
    await server!.shutdown();
    await start({ internalSecret: undefined });
    const response = await fetch(`http://127.0.0.1:${port}/multiplayer/internal/access-changed`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });
});
