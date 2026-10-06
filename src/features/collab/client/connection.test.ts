import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION, SOCKET_PROTOCOL, tokenFromProtocols, type ServerMessage } from '../protocol';
import { CollabConnection } from './connection';

/**
 * Connexion WebSocket du client (minuteries simulées, WebSocket factice) :
 * battement de cœur dans un onglet en arrière-plan (minuteries bridées à une
 * par minute par Chrome), connexion morte détectée, vérification au retour de
 * l'onglet ou du réseau, jeton recréé après un refus.
 */

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  /** Répond aux pings (connexion vivante). */
  alive = true;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  readonly url: string;
  readonly protocols: string[];

  constructor(url: string, protocols: string[] = []) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === 'hello') queueMicrotask(() => this.receive(welcome()));
    if (message.type === 'ping' && this.alive) queueMicrotask(() => this.receive({ type: 'pong', t: message.t as number }));
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: ServerMessage): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function welcome(): ServerMessage {
  return {
    type: 'welcome',
    v: PROTOCOL_VERSION,
    epoch: 'e1',
    clientId: 'c1',
    userId: 'u1',
    seq: 0,
    durableSeq: 0,
    clientSeq: 0,
    snapshot: { seq: 0, objects: [['p', null, null, null, [['name', 'Projet']]]], blobs: {} },
    peers: [],
    leases: [],
  };
}

const tokens: Array<{ fresh?: boolean } | undefined> = [];

function connection(): CollabConnection {
  const created = new CollabConnection({
    url: 'ws://test/multiplayer',
    projectId: 'p1',
    clientId: 'c1',
    getToken: async (options) => {
      tokens.push(options);
      return 'jwt';
    },
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });
  created.client.bind({ name: 'Projet', itineraries: [] } as never, []);
  return created;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

/** Ouvre la connexion courante (dernier WebSocket créé) et attend le `welcome`. */
async function openLatest(): Promise<FakeSocket> {
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  socket.open();
  await settle();
  return socket;
}

describe('connexion temps réel', () => {
  let globals: { window?: unknown; document?: unknown };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    tokens.length = 0;
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    globals = { window: (globalThis as Record<string, unknown>).window, document: (globalThis as Record<string, unknown>).document };
    (globalThis as Record<string, unknown>).window = new EventTarget();
    (globalThis as Record<string, unknown>).document = doc;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as Record<string, unknown>).window = globals.window;
    (globalThis as Record<string, unknown>).document = globals.document;
  });

  it('onglet en arrière-plan (minuteries une fois par minute) : aucune reconnexion tant que le serveur répond', async () => {
    const realSetInterval = globalThis.setInterval;
    // Chrome, onglet caché depuis 5 min : les minuteries ne se réveillent qu'une fois par minute.
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms?: number) => realSetInterval(callback, Math.max(ms ?? 0, 60_000))) as typeof setInterval);
    const link = connection();
    link.start();
    await openLatest();
    expect(link.client.getState().status).toBe('online');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(link.client.getState().status).toBe('online');
    link.stop();
  });

  it('connexion morte sans fermeture : détectée et rouverte en moins de 30 s', async () => {
    const link = connection();
    link.start();
    const first = await openLatest();
    first.alive = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    expect(first.readyState).toBe(3);
    link.stop();
  });

  it('retour de l’onglet ou du réseau : vérifiée tout de suite, rouverte en ≈ 4 s si elle est morte', async () => {
    const link = connection();
    link.start();
    const first = await openLatest();
    // Mise en veille : la connexion est morte, rien ne l'a dit au navigateur.
    first.alive = false;
    (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances.length).toBe(2);
    link.stop();
  });

  it('en attente d’une nouvelle tentative : le retour du réseau reconnecte sans attendre', async () => {
    const link = connection();
    link.start();
    const first = await openLatest();
    // Plusieurs échecs : l'attente grandit (jusqu'à 15 s).
    for (let index = 0; index < 5; index += 1) {
      FakeSocket.instances[FakeSocket.instances.length - 1].close(1006);
      await settle();
      await vi.advanceTimersByTimeAsync(16_000);
    }
    const count = FakeSocket.instances.length;
    FakeSocket.instances[count - 1].close(1006);
    await settle();
    (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances.length).toBe(count + 1);
    expect(first).not.toBe(FakeSocket.instances[count]);
    link.stop();
  });

  it('jeton présenté à l’ouverture (sous-protocole), projet dans l’URL, jamais dans `hello`', async () => {
    const link = connection();
    link.start();
    const socket = await openLatest();
    expect(socket.url).toBe('ws://test/multiplayer?project=p1');
    expect(socket.protocols[0]).toBe(SOCKET_PROTOCOL);
    expect(tokenFromProtocols(socket.protocols)).toBe('jwt');
    const hello = socket.sent.find((message) => message.type === 'hello')!;
    expect(hello).not.toHaveProperty('token');
    expect(hello).not.toHaveProperty('projectId');
    link.stop();
  });

  it('relève du jeton toutes les 4 min sur la connexion ouverte (le serveur ferme un jeton expiré)', async () => {
    const link = connection();
    link.start();
    const socket = await openLatest();
    expect(socket.sent.filter((message) => message.type === 'auth')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await settle();
    expect(socket.sent.filter((message) => message.type === 'auth')).toEqual([{ type: 'auth', token: 'jwt' }]);
    link.stop();
  });

  it('refus du jeton à répétition (4401) : session expirée, plus de nouvelle tentative', async () => {
    const link = connection();
    link.start();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Refusée à l'ouverture (avant tout `welcome`), comme le fait le serveur.
      await vi.advanceTimersByTimeAsync(0);
      FakeSocket.instances[FakeSocket.instances.length - 1].close(4401);
      await settle();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(link.client.getState().status).toBe('denied');
    link.stop();
  });

  it('jeton refusé (4401) : le suivant est recréé, pas repris du cache', async () => {
    const link = connection();
    link.start();
    const first = await openLatest();
    expect(tokens.at(-1)).toEqual({ fresh: false });
    first.receive({ type: 'error', code: 'unauthorized' });
    first.close(4401);
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tokens.at(-1)).toEqual({ fresh: true });
    link.stop();
  });
});
