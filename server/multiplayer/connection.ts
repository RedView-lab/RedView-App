import type { WebSocket } from 'ws';

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerErrorCode,
  type ServerMessage,
} from '../../src/features/collab/protocol.ts';
import type { SendOptions } from '../../src/features/collab/room/room.ts';
import type { Authenticator, Identity } from './auth.ts';
import type { HostedRoom, PeerHandle, RoomHost } from './roomHost.ts';

/**
 * Une connexion WebSocket déjà authentifiée à l'ouverture (server.ts : jeton,
 * droits, origine, plafonds) : `hello` (version, client) → salle → messages
 * relayés à la salle, dans l'ordre. Codes de fermeture (le client décide s'il
 * se reconnecte) : 4400 requête invalide, 4401 jeton refusé ou expiré sans
 * relève, 4403 accès retiré, 4404 projet introuvable, 4408 client trop lent,
 * 4409 remplacée par une nouvelle connexion du même client, 4426 version,
 * 4429 trop de messages, 1011/1013 erreur ou serveur occupé (réessayer),
 * 1012 redémarrage.
 */

export interface ConnectionOptions {
  host: RoomHost;
  auth: Authenticator;
  /** Utilisateur vérifié à l'ouverture et projet demandé (droits vérifiés). */
  identity: Identity;
  projectId: string;
  /** Développement : un projet inconnu est créé à partir du document du premier client. */
  acceptSeed: boolean;
  log: RoomHost['log'];
  timings?: Partial<ConnectionTimings>;
}

export interface ConnectionTimings {
  /** Revérification périodique des droits et de l'expiration du jeton. */
  accessRecheckMs: number;
  /** Délai laissé à la relève du jeton après son expiration (horloges, onglet en arrière-plan). */
  tokenGraceMs: number;
}

const DEFAULT_TIMINGS: ConnectionTimings = { accessRecheckMs: 15_000, tokenGraceMs: 60_000 };
const HELLO_TIMEOUT_MS = 10_000;
/** Au-delà, le client ne suit plus (réseau lent) : il se reconnectera et repartira de l'état complet. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
/**
 * Message éphémère (`motion`) sauté au-delà : sa place est derrière des lots
 * en attente, et le suivant le remplace (un curseur en retard ne sert à rien).
 */
const MAX_VOLATILE_BUFFERED_BYTES = 256 * 1024;
/**
 * Débit d'un client (seau à jetons) : lots (≈ 30 Hz, un arriéré ≤ 120/s côté
 * client) + `motion` (≤ 36/s, débit propre dans la salle) + présence + pings,
 * avec de la marge ; rafale de 1 200 (reprise après une coupure).
 */
const RATE_PER_SECOND = 120;
const RATE_BURST_MESSAGES = 1_200;
/**
 * Débit en octets d'un client : au-delà, la lecture de sa connexion est mise
 * en pause le temps que le seau se remplisse (TCP le ralentit, rien n'est
 * coupé) — un client ne monopolise ni la mémoire ni le fil du serveur.
 */
const BYTES_PER_SECOND = 16 * 1024 * 1024;
const BYTES_BURST = 64 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Un message diffusé à toute la salle n'est sérialisé qu'une fois. */
const wireCache = new WeakMap<ServerMessage, string>();

function toWire(message: ServerMessage): string {
  let wire = wireCache.get(message);
  if (wire === undefined) {
    wire = JSON.stringify(message);
    wireCache.set(message, wire);
  }
  return wire;
}

export const CLOSE_CODES: Record<ServerErrorCode, number> = {
  'unauthorized': 4401,
  'forbidden': 4403,
  'not-found': 4404,
  'version': 4426,
  'busy': 1013,
  'bad-request': 4400,
  'internal': 1011,
};

export function handleConnection(socket: WebSocket, options: ConnectionOptions): void {
  const { identity, projectId } = options;
  const timings = { ...DEFAULT_TIMINGS, ...options.timings };
  const userId = identity.userId;
  let tokenExpiresAt = identity.expiresAt;
  let hosted: HostedRoom | null = null;
  let handle: PeerHandle | null = null;
  let phase: 'hello' | 'joining' | 'joined' | 'closed' = 'hello';
  let recheck: NodeJS.Timeout | null = null;
  let resumeTimer: NodeJS.Timeout | null = null;
  let tokens = RATE_BURST_MESSAGES;
  let tokensAt = Date.now();
  let bytes = BYTES_BURST;
  let bytesAt = Date.now();
  let unregisterAccess: (() => void) | null = null;

  const helloTimer = setTimeout(() => fail('bad-request', 'hello-timeout'), HELLO_TIMEOUT_MS);

  function send(message: ServerMessage, sendOptions?: SendOptions): void {
    if (socket.readyState !== socket.OPEN) return;
    if (sendOptions?.volatile && socket.bufferedAmount > MAX_VOLATILE_BUFFERED_BYTES) {
      options.host.metrics.motionSkippedBackpressure += 1;
      return;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      close(4408, 'slow-consumer');
      return;
    }
    socket.send(toWire(message));
  }

  function close(code: number, reason: string): void {
    if (phase === 'closed') return;
    phase = 'closed';
    // Refus et erreurs (4xxx, 1011) journalisés : un client renvoyé hors d'un projet se diagnostique ici.
    if (code >= 4000 || code === 1011) options.log('warn', 'connexion fermée par le serveur', { code, reason, projectId, userId });
    clearTimeout(helloTimer);
    if (recheck) clearInterval(recheck);
    if (resumeTimer) clearTimeout(resumeTimer);
    unregisterAccess?.();
    if (hosted && handle) hosted.detach(handle);
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }
  }

  function fail(code: ServerErrorCode, message?: string): void {
    send({ type: 'error', code, message });
    close(CLOSE_CODES[code], message ?? code);
  }

  /** Droits et jeton revérifiés (périodiquement, et tout de suite sur révocation signalée). */
  function verify(fresh: boolean): void {
    if (phase === 'closed') return;
    if (Date.now() > tokenExpiresAt + timings.tokenGraceMs) {
      fail('unauthorized', 'token-expired');
      return;
    }
    options.auth.checkAccess(userId, projectId, { fresh }).then((result) => {
      // Projet supprimé : toute la salle est fermée (4404) et purgée ;
      // accès retiré : seulement cette connexion (4403).
      if (result === 'not-found') hosted?.projectDeleted('revérification des droits');
      else if (result !== 'ok') fail('forbidden', 'access-revoked');
    }, (error: unknown) => options.log('warn', 'revérification des droits impossible', { error: String(error) }));
  }

  /** Relève du jeton : même utilisateur, nouvelle expiration ; un jeton refusé ferme la connexion. */
  function reauthenticate(token: unknown): void {
    if (typeof token !== 'string') return fail('bad-request', 'auth');
    options.auth.verifyToken(token).then((next) => {
      if (phase === 'closed') return;
      if (!next || next.userId !== userId) {
        fail('unauthorized', 'auth-refused');
        return;
      }
      tokenExpiresAt = Math.max(tokenExpiresAt, next.expiresAt);
    }, (error: unknown) => {
      // Appwrite injoignable : l'expiration actuelle tient, la relève suivante réessaiera.
      options.log('warn', 'relève du jeton impossible', { error: String(error) });
    });
  }

  async function hello(message: Extract<ClientMessage, { type: 'hello' }>): Promise<void> {
    clearTimeout(helloTimer);
    if (message.v !== PROTOCOL_VERSION) return fail('version', `protocole ${PROTOCOL_VERSION} attendu`);
    if (typeof message.clientId !== 'string' || !ID_PATTERN.test(message.clientId)) return fail('bad-request', 'ids');

    let room: HostedRoom | null = null;
    for (let attempt = 0; attempt < 2 && (!room || room.closed); attempt += 1) {
      room = await options.host.open(projectId, options.acceptSeed ? message.seed : undefined);
      if (!room) return fail('not-found');
    }
    if (!room || room.closed) return fail('busy', 'room-closing');
    if (phase !== 'joining') return;

    const peerHandle: PeerHandle = {
      peer: { clientId: message.clientId, userId, ...(identity.name ? { name: identity.name } : {}), send },
      close: (code, reason) => close(code, reason),
    };
    if (!room.attach(peerHandle, { epoch: message.epoch ?? null, lastSeq: message.lastSeq ?? null, presence: message.presence })) {
      return fail('bad-request', 'client-id');
    }
    hosted = room;
    handle = peerHandle;
    phase = 'joined';
    unregisterAccess = options.host.onAccessChanged(projectId, () => verify(true));
    recheck = setInterval(() => verify(false), timings.accessRecheckMs);
  }

  /** Seau d'octets : la lecture est suspendue tant qu'il est vide (le client est ralenti, pas coupé). */
  function takeBytes(size: number): void {
    const now = Date.now();
    bytes = Math.min(BYTES_BURST, bytes + ((now - bytesAt) * BYTES_PER_SECOND) / 1000);
    bytesAt = now;
    bytes -= size;
    if (bytes >= 0 || resumeTimer) return;
    options.host.metrics.bytesThrottled += 1;
    socket.pause();
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (phase !== 'closed') socket.resume();
    }, Math.ceil((-bytes * 1000) / BYTES_PER_SECOND));
  }

  socket.on('message', (data, isBinary) => {
    if (phase === 'closed') return;
    const now = Date.now();
    tokens = Math.min(RATE_BURST_MESSAGES, tokens + ((now - tokensAt) * RATE_PER_SECOND) / 1000);
    tokensAt = now;
    if (tokens < 1) {
      options.host.metrics.rateLimited += 1;
      close(4429, 'rate-limit');
      return;
    }
    tokens -= 1;
    const size = Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.length, 0) : (data as Buffer | ArrayBuffer).byteLength;
    takeBytes(size);
    if (isBinary) return fail('bad-request', 'binary');
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return fail('bad-request', 'json');
    }
    if (message === null || typeof message !== 'object' || typeof message.type !== 'string') return fail('bad-request', 'message');

    if (phase === 'hello') {
      if (message.type !== 'hello') return fail('bad-request', 'hello-expected');
      phase = 'joining';
      hello(message).catch((error: unknown) => {
        options.log('error', 'connexion à la salle impossible', { error: String(error), projectId });
        fail(error instanceof Error && error.message === 'busy' ? 'busy' : 'internal', 'room-unavailable');
      });
      return;
    }
    // Rien n'est envoyé avant `welcome` (le client attend) : ignoré pendant l'entrée.
    if (phase !== 'joined' || !hosted || !handle) return;
    if (message.type === 'auth') return reauthenticate(message.token);
    hosted.handle(handle, message);
  });

  socket.on('close', () => close(1000, 'closed'));
  socket.on('error', () => close(1011, 'socket-error'));
}
