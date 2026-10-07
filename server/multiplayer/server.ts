import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { createRateLimiter, getClientIp, rateLimitKeyForIp } from '../lib/http-security.mjs';
import { SOCKET_PROTOCOL, tokenFromProtocols, type ServerErrorCode } from '../../src/features/collab/protocol.ts';
import { WIRE_MAX_MESSAGE_BYTES } from '../../src/features/collab/wire.ts';
import { createAuthenticator, type AuthOptions, type Authenticator, type Identity } from './auth.ts';
import { CLOSE_CODES, handleConnection, type ConnectionTimings } from './connection.ts';
import { CLOSE_RESTART, RoomHost, type RoomHostOptions } from './roomHost.ts';
import type { RoomStorage } from './storage.ts';
import { createWriteCoalescer } from './writeCoalescer.ts';

/**
 * Serveur temps réel : HTTP public (`/health`, seulement `{"ok":true}` : lu
 * par l'application et par la vérification du déploiement ; `POST
 * /internal/access-changed`, signé, appelé par l'API de partage) + WebSocket
 * (`/multiplayer`). Les mesures (salles, clients, latences, erreurs,
 * validation fantôme, mémoire) sont servies à part, sur un port interne
 * (`listenMetrics`, 127.0.0.1 du conteneur) : jamais derrière le proxy
 * public. Démarré par main.ts (variables d'environnement) et par les tests
 * d'intégration (stockage de fichiers, authentification de dev).
 *
 * Ouverture d'une WebSocket (OWASP) : l'origine (navigateur) est vérifiée,
 * les ouvertures et connexions par IP, les connexions par utilisateur et les
 * authentifications en cours sont plafonnées, puis le jeton (sous-protocole)
 * et les droits sur le projet (`?project=`) sont vérifiés AVANT d'accepter
 * la connexion : un refus passe par un second serveur WebSocket (messages ≤
 * 1 Ko, rien n'est lu) qui ferme aussitôt avec le code du refus, que le client
 * sait interpréter (un refus HTTP ne lui donnerait aucun code).
 */

interface ConnectionLimits {
  /** Connexions WebSocket ouvertes par IP (un /64 en IPv6). */
  perIp: number;
  /** Ouvertures par IP et par minute. */
  upgradesPerIpPerMinute: number;
  /** Connexions ouvertes par utilisateur (onglets, appareils). */
  perUser: number;
  /** Authentifications en cours (appels à Appwrite) pour tout le serveur. */
  pendingAuth: number;
}

const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = { perIp: 32, upgradesPerIpPerMinute: 60, perUser: 16, pendingAuth: 256 };

export interface MultiplayerServerOptions {
  storage: RoomStorage;
  appwrite: AuthOptions['appwrite'];
  devAuth: boolean;
  host?: Omit<RoomHostOptions, 'storage'>;
  /**
   * Origines de navigateur acceptées (`https://app.redview.tech`). Une
   * connexion sans en-tête `Origin` (client hors navigateur) est acceptée :
   * l'origine ne protège que les navigateurs, le jeton protège tout le reste.
   * Absent : toutes (tests) ; en développement, `http://localhost:*`.
   */
  allowedOrigins?: readonly string[];
  limits?: Partial<ConnectionLimits>;
  /** Secret partagé avec l'API de partage (`POST /internal/access-changed`) ; absent : route fermée. */
  internalSecret?: string;
  /** Tests : authentification fournie (sinon Appwrite, ou jetons de dev). */
  authenticator?: Authenticator;
  /** Tests : délais de revérification raccourcis. */
  timings?: Partial<ConnectionTimings>;
}

export interface MultiplayerServer {
  host: RoomHost;
  listen(port: number, hostname?: string): Promise<number>;
  /** Mesures sur un port interne (`/metrics` au format Prometheus, `/metrics.json`). */
  listenMetrics(port: number, hostname?: string): Promise<number>;
  /** Arrêt propre : journal écrit, connexions fermées (1012). */
  shutdown(): Promise<void>;
}

const HEARTBEAT_MS = 15_000;
/** Vérification du jeton et des droits à l'ouverture : au-delà, refus (1013, le client réessaie). */
const UPGRADE_AUTH_TIMEOUT_MS = 10_000;
/** Au-delà de cette part du tas, plus aucune connexion n'est acceptée (1013). */
const CONNECTION_HEAP_RATIO = 0.85;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Révocation signalée : horodatage accepté à ± cette durée, corps borné, débit borné. */
const INTERNAL_MAX_SKEW_MS = 60_000;
const INTERNAL_MAX_BODY_BYTES = 1_024;
const INTERNAL_MAX_PER_MINUTE = 300;

/**
 * Chemins acceptés : `/multiplayer` (proxy qui garde le chemin, Vite en dev)
 * ou `/` (proxy avec « strip prefix ») ; idem pour `/health`, avec ou sans
 * le préfixe.
 */
const SOCKET_PATHS = new Set(['/', '/multiplayer', '/multiplayer/']);

const CLOSE_REASONS: Partial<Record<number, ServerErrorCode>> = Object.fromEntries(
  Object.entries(CLOSE_CODES).map(([reason, code]) => [code, reason as ServerErrorCode]),
);

function routeOf(pathname: string): string {
  return pathname.startsWith('/multiplayer/') ? pathname.slice('/multiplayer'.length) : pathname;
}

function listenOn(server: http.Server, port: number, hostname?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => resolve((server.address() as AddressInfo).port));
  });
}

/** Origine acceptée : absente (hors navigateur), dans la liste, ou locale en développement. */
function originChecker(allowed: readonly string[] | undefined, devAuth: boolean): (origin: string | undefined) => boolean {
  if (!allowed) return () => true;
  const set = new Set(allowed);
  return (origin) => {
    if (origin === undefined) return true;
    if (set.has(origin)) return true;
    return devAuth && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  };
}

/** Sous-protocoles de l'en-tête (`a, b`) ; vide s'il est absent. */
function parseProtocols(header: string | undefined): Set<string> {
  return new Set((header ?? '').split(',').map((value) => value.trim()).filter(Boolean));
}

/** Refus avant toute WebSocket (chemin, origine, débit) : réponse HTTP minimale. */
function rejectHttp(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Compteur borné par clé (connexions ouvertes) ; `take` renvoie de quoi rendre la place, ou null. */
function createCounter(max: () => number) {
  const counts = new Map<string, number>();
  return (key: string): (() => void) | null => {
    const count = counts.get(key) ?? 0;
    if (count >= max()) return null;
    counts.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (counts.get(key) ?? 1) - 1;
      if (left > 0) counts.set(key, left);
      else counts.delete(key);
    };
  };
}

/** Fenêtre d'une minute par clé (ouvertures par IP), bornée en nombre de clés (limiteur de l'app). */
function createMinuteLimiter(max: () => number) {
  const hit = createRateLimiter({ windowMs: 60_000, maxKeys: 50_000 });
  return (key: string): boolean => hit(key, max());
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('busy')), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function createMultiplayerServer(options: MultiplayerServerOptions): MultiplayerServer {
  const host = new RoomHost({ storage: options.storage, ...options.host });
  const auth: Authenticator = options.authenticator
    ?? createAuthenticator({ storage: options.storage, appwrite: options.appwrite, devAuth: options.devAuth });
  const limits: ConnectionLimits = { ...DEFAULT_CONNECTION_LIMITS, ...options.limits };
  const originAllowed = originChecker(options.allowedOrigins, options.devAuth);
  const takeIpSlot = createCounter(() => limits.perIp);
  const takeUserSlot = createCounter(() => limits.perUser);
  const allowUpgrade = createMinuteLimiter(() => limits.upgradesPerIpPerMinute);
  const allowInternal = createMinuteLimiter(() => INTERNAL_MAX_PER_MINUTE);
  let pendingAuth = 0;
  let shuttingDown = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routeOf(url.pathname);
    if (req.method === 'GET' && route === '/health') {
      res.writeHead(shuttingDown ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: !shuttingDown }));
      return;
    }
    if (req.method === 'POST' && route === '/internal/access-changed' && options.internalSecret) {
      handleAccessChanged(req, res, options.internalSecret);
      return;
    }
    res.writeHead(404).end();
  });

  /**
   * Révocation signalée par l'API de partage : corps `{ projectId, ts }`
   * signé (HMAC-SHA256, en-tête `x-redview-signature`), horodaté. Effet : les
   * connexions du projet revérifient leurs droits tout de suite — un message
   * rejoué ou forgé ne peut rien faire d'autre.
   */
  function handleAccessChanged(req: http.IncomingMessage, res: http.ServerResponse, secret: string): void {
    if (!allowInternal('internal')) {
      res.writeHead(429).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > INTERNAL_MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      const body = Buffer.concat(chunks);
      const signature = String(req.headers['x-redview-signature'] ?? '');
      const expected = createHmac('sha256', secret).update(body).digest();
      const given = /^[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        host.log('warn', 'révocation refusée : signature invalide');
        res.writeHead(401).end();
        return;
      }
      let parsed: { projectId?: unknown; ts?: unknown };
      try {
        parsed = JSON.parse(body.toString('utf8')) as { projectId?: unknown; ts?: unknown };
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof parsed.projectId !== 'string' || !ID_PATTERN.test(parsed.projectId)
        || typeof parsed.ts !== 'number' || Math.abs(Date.now() - parsed.ts) > INTERNAL_MAX_SKEW_MS) {
        res.writeHead(400).end();
        return;
      }
      auth.forgetProject(parsed.projectId);
      host.accessChanged(parsed.projectId);
      res.writeHead(204).end();
    });
  }

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

  const handleProtocols = (protocols: Set<string>) => (protocols.has(SOCKET_PROTOCOL) ? SOCKET_PROTOCOL : false);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WIRE_MAX_MESSAGE_BYTES,
    // Pas de `permessage-deflate` : Chromium y compresse chaque message (lots, caméra et curseur
    // à 30 Hz), décompressés un à un dans la file zlib du processus, et chaque gros message était
    // compressé une fois par destinataire — la charge cible saturait (`bench:collab-load` : 13 s de
    // retard à 50 salles). Les gros messages sont compressés par l'application, une fois (wire.ts).
    perMessageDeflate: false,
    handleProtocols,
  });
  /** Connexions refusées : ouvertes le temps de leur donner le code du refus, sans rien lire. */
  const denyWss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false, clientTracking: false, handleProtocols });

  // Les erreurs du serveur HTTP (port déjà pris…) sont aussi émises ici : traitées par `listen`.
  wss.on('error', (error) => host.log('error', 'serveur WebSocket', { error: String(error) }));

  function deny(req: http.IncomingMessage, socket: Duplex, head: Buffer, code: number, reason: string, data: Record<string, unknown>): void {
    host.metrics.connectionsRefused += 1;
    if (code !== CLOSE_RESTART) host.log('warn', 'connexion refusée', { code, reason, ...data });
    if (socket.destroyed) return;
    denyWss.handleUpgrade(req, socket, head, (ws) => {
      // Ce que le client envoie encore (> 1 Ko : erreur de taille) n'est jamais lu ;
      // sans écouteur, l'erreur émise ferait tomber le processus.
      ws.on('error', () => ws.terminate());
      const errorCode = CLOSE_REASONS[code];
      if (errorCode) ws.send(JSON.stringify({ type: 'error', code: errorCode, message: reason }));
      ws.close(code, reason);
    });
  }

  async function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!SOCKET_PATHS.has(url.pathname)) return rejectHttp(socket, 404, 'Not Found');
    const ip = rateLimitKeyForIp(getClientIp(req));
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!originAllowed(origin)) {
      host.metrics.connectionsRefused += 1;
      host.log('warn', 'connexion refusée : origine', { origin: origin?.slice(0, 200), ip });
      return rejectHttp(socket, 403, 'Forbidden');
    }
    if (!allowUpgrade(ip)) {
      host.metrics.connectionsRefused += 1;
      return rejectHttp(socket, 429, 'Too Many Requests');
    }
    const releaseIp = takeIpSlot(ip);
    if (!releaseIp) {
      host.metrics.connectionsRefused += 1;
      return rejectHttp(socket, 429, 'Too Many Requests');
    }
    socket.once('close', releaseIp);
    if (shuttingDown) return deny(req, socket, head, CLOSE_RESTART, 'shutdown', { ip });

    const protocols = parseProtocols(req.headers['sec-websocket-protocol'] as string | undefined);
    if (!protocols.has(SOCKET_PROTOCOL)) return deny(req, socket, head, CLOSE_CODES.version, 'version', { ip });
    const token = tokenFromProtocols(protocols);
    const projectId = url.searchParams.get('project');
    if (!token || !projectId || !ID_PATTERN.test(projectId)) return deny(req, socket, head, CLOSE_CODES['bad-request'], 'bad-request', { ip });
    if (pendingAuth >= limits.pendingAuth || host.heapRatio() > CONNECTION_HEAP_RATIO) {
      return deny(req, socket, head, CLOSE_CODES.busy, 'busy', { ip, projectId });
    }

    let identity: Identity | null;
    pendingAuth += 1;
    try {
      identity = await withTimeout(auth.verifyToken(token), UPGRADE_AUTH_TIMEOUT_MS);
      if (!identity) return deny(req, socket, head, CLOSE_CODES.unauthorized, 'unauthorized', { ip, projectId });
      const access = await withTimeout(auth.checkAccess(identity.userId, projectId, { fresh: true }), UPGRADE_AUTH_TIMEOUT_MS);
      if (access !== 'ok') return deny(req, socket, head, CLOSE_CODES[access], access, { ip, projectId, userId: identity.userId });
    } catch (error) {
      // Appwrite injoignable ou trop lent : à réessayer (jamais un refus de jeton).
      const busy = error instanceof Error && error.message === 'busy';
      return deny(req, socket, head, busy ? CLOSE_CODES.busy : CLOSE_CODES.internal, busy ? 'busy' : 'auth-unavailable', { ip, projectId, error: String(error) });
    } finally {
      pendingAuth -= 1;
    }
    if (socket.destroyed) return;
    const releaseUser = takeUserSlot(identity.userId);
    if (!releaseUser) return deny(req, socket, head, CLOSE_CODES.busy, 'too-many-connections', { ip, userId: identity.userId });
    socket.once('close', releaseUser);
    const verified = identity;
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (shuttingDown) {
        ws.close(CLOSE_RESTART, 'shutdown');
        return;
      }
      onConnection(ws, verified, projectId, socket);
    });
  }

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrade(req, socket, head).catch((error: unknown) => {
      host.log('error', 'ouverture de connexion impossible', { error: String(error) });
      socket.destroy();
    });
  });

  // Connexions mortes (réseau coupé sans fermeture) : ping toutes les 15 s (pastille et
  // curseur fantômes ≤ 30 s ; le navigateur répond même dans un onglet en arrière-plan).
  const alive = new WeakSet<object>();
  const coalescer = createWriteCoalescer();
  function onConnection(socket: WebSocket, identity: Identity, projectId: string, raw: Duplex): void {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    handleConnection(socket, { host, auth, identity, projectId, acceptSeed: options.devAuth, log: host.log.bind(host), timings: options.timings, writes: { socket: raw, coalescer } });
  }
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
    listen: (port, hostname) => listenOn(server, port, hostname),
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
