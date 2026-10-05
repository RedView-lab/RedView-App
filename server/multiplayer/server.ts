import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import { createAuthenticator, type AuthOptions } from './auth.ts';
import { handleConnection } from './connection.ts';
import { CLOSE_RESTART, RoomHost, type RoomHostOptions } from './roomHost.ts';
import type { RoomStorage } from './storage.ts';

/**
 * Serveur temps réel : HTTP (`/health`, `/metrics`) + WebSocket
 * (`/multiplayer`). Démarré par main.ts (variables d'environnement) et par
 * les tests d'intégration (stockage de fichiers, authentification de dev).
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
  /** Arrêt propre : journal écrit, connexions fermées (1012). */
  shutdown(): Promise<void>;
}

const HEARTBEAT_MS = 30_000;

/**
 * Chemins acceptés : `/multiplayer` (proxy qui garde le chemin, Vite en dev)
 * ou `/` (Traefik/Coolify avec « strip prefix ») ; idem pour `/health` et
 * `/metrics`, avec ou sans le préfixe.
 */
const SOCKET_PATHS = new Set(['/', '/multiplayer', '/multiplayer/']);

function routeOf(pathname: string): string {
  return pathname.startsWith('/multiplayer/') ? pathname.slice('/multiplayer'.length) : pathname;
}

export function createMultiplayerServer(options: MultiplayerServerOptions): MultiplayerServer {
  const host = new RoomHost({ storage: options.storage, ...options.host });
  const auth = createAuthenticator({ storage: options.storage, appwrite: options.appwrite, devAuth: options.devAuth });
  let shuttingDown = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routeOf(url.pathname);
    if (req.method === 'GET' && route === '/health') {
      res.writeHead(shuttingDown ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: !shuttingDown, ...host.snapshotMetrics() }));
      return;
    }
    if (req.method === 'GET' && route === '/metrics') {
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
    listen(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve((server.address() as AddressInfo).port));
      });
    },
    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(heartbeat);
      await host.shutdown();
      for (const socket of wss.clients) socket.close(CLOSE_RESTART, 'shutdown');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
