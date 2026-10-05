import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import { createAuthenticator, type AuthOptions } from './auth.ts';
import { handleConnection } from './connection.ts';
import { CLOSE_RESTART, RoomHost, type RoomHostOptions } from './roomHost.ts';
import type { RoomStorage } from './storage.ts';

/**
 * Serveur temps réel : HTTP public (`/health`, seulement `{"ok":true}` : lu
 * par l'application et par la vérification du déploiement) + WebSocket
 * (`/multiplayer`). Les mesures (salles, clients, latences, erreurs,
 * validation fantôme, mémoire) sont servies à part, sur un port interne
 * (`listenMetrics`, 127.0.0.1 du conteneur) : jamais derrière le proxy
 * public. Démarré par main.ts (variables d'environnement) et par les tests
 * d'intégration (stockage de fichiers, authentification de dev).
 */

export interface MultiplayerServerOptions {
  storage: RoomStorage;
  appwrite: AuthOptions['appwrite'];
  devAuth: boolean;
  host?: Omit<RoomHostOptions, 'storage'>;
}

export interface MultiplayerServer {
  host: RoomHost;
  listen(port: number): Promise<number>;
  /** Mesures sur un port interne (`/metrics` au format Prometheus, `/metrics.json`). */
  listenMetrics(port: number, hostname?: string): Promise<number>;
  /** Arrêt propre : journal écrit, connexions fermées (1012). */
  shutdown(): Promise<void>;
}

const HEARTBEAT_MS = 30_000;

/**
 * Chemins acceptés : `/multiplayer` (proxy qui garde le chemin, Vite en dev)
 * ou `/` (proxy avec « strip prefix ») ; idem pour `/health`, avec ou sans
 * le préfixe.
 */
const SOCKET_PATHS = new Set(['/', '/multiplayer', '/multiplayer/']);

function routeOf(pathname: string): string {
  return pathname.startsWith('/multiplayer/') ? pathname.slice('/multiplayer'.length) : pathname;
}

function listenOn(server: http.Server, port: number, hostname?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => resolve((server.address() as AddressInfo).port));
  });
}

export function createMultiplayerServer(options: MultiplayerServerOptions): MultiplayerServer {
  const host = new RoomHost({ storage: options.storage, ...options.host });
  const auth = createAuthenticator({ storage: options.storage, appwrite: options.appwrite, devAuth: options.devAuth });
  let shuttingDown = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && routeOf(url.pathname) === '/health') {
      res.writeHead(shuttingDown ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: !shuttingDown }));
      return;
    }
    res.writeHead(404).end();
  });

  const metricsServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/metrics.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: !shuttingDown, ...host.snapshotMetrics() }));
      return;
    }
    if (url.pathname === '/metrics') {
      const lines = Object.entries(host.snapshotMetrics()).map(([key, value]) => `redview_multiplayer_${key} ${value}`);
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(`${lines.join('\n')}\n`);
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server,
    verifyClient: ({ req }: { req: http.IncomingMessage }) => SOCKET_PATHS.has(new URL(req.url ?? '/', 'http://localhost').pathname),
    maxPayload: 64 * 1024 * 1024,
    perMessageDeflate: { threshold: 1024, concurrencyLimit: 4 },
  });

  // Les erreurs du serveur HTTP (port déjà pris…) sont aussi émises ici : traitées par `listen`.
  wss.on('error', (error) => host.log('error', 'serveur WebSocket', { error: String(error) }));

  // Connexions mortes (réseau coupé sans fermeture) : ping toutes les 30 s.
  const alive = new WeakSet<object>();
  wss.on('connection', (socket) => {
    if (shuttingDown) {
      socket.close(CLOSE_RESTART, 'shutdown');
      return;
    }
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    handleConnection(socket, { host, auth, acceptSeed: options.devAuth, log: host.log.bind(host) });
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, HEARTBEAT_MS);

  return {
    host,
    listen: (port) => listenOn(server, port),
    listenMetrics: (port, hostname = '127.0.0.1') => listenOn(metricsServer, port, hostname),
    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(heartbeat);
      await host.shutdown();
      for (const socket of wss.clients) socket.close(CLOSE_RESTART, 'shutdown');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (metricsServer.listening) await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    },
  };
}
