import type { WebSocket } from 'ws';

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerErrorCode,
  type ServerMessage,
} from '../../src/features/collab/protocol.ts';
import type { SendOptions } from '../../src/features/collab/room/room.ts';
import type { Authenticator } from './auth.ts';
import type { HostedRoom, PeerHandle, RoomHost } from './roomHost.ts';

/**
 * Une connexion WebSocket : `hello` (version, jeton, droits) → salle → messages
 * relayés à la salle, dans l'ordre. Codes de fermeture (le client décide s'il
 * se reconnecte) : 4400 requête invalide, 4401 jeton refusé, 4403 accès
 * retiré, 4404 projet introuvable, 4408 client trop lent, 4409 remplacée par
 * une nouvelle connexion du même client, 4426 version, 4429 trop de messages,
 * 1011/1013 erreur ou serveur occupé (réessayer), 1012 redémarrage.
 */

export interface ConnectionOptions {
  host: RoomHost;
  auth: Authenticator;
  /** Développement : un projet inconnu est créé à partir du document du premier client. */
  acceptSeed: boolean;
  log: RoomHost['log'];
}

const HELLO_TIMEOUT_MS = 10_000;
const ACCESS_RECHECK_MS = 60_000;
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

const CLOSE_CODES: Record<ServerErrorCode, number> = {
  'unauthorized': 4401,
  'forbidden': 4403,
  'not-found': 4404,
  'version': 4426,
  'busy': 1013,
  'bad-request': 4400,
  'internal': 1011,
};

export function handleConnection(socket: WebSocket, options: ConnectionOptions): void {
  let hosted: HostedRoom | null = null;
  let handle: PeerHandle | null = null;
  /** Projet demandé (journal des refus). */
  let projectId: string | null = null;
  let phase: 'hello' | 'joining' | 'joined' | 'closed' = 'hello';
  let recheck: NodeJS.Timeout | null = null;
  let tokens = RATE_BURST_MESSAGES;
  let tokensAt = Date.now();

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
    if (code >= 4000 || code === 1011) options.log('warn', 'connexion fermée par le serveur', { code, reason, projectId });
    clearTimeout(helloTimer);
    if (recheck) clearInterval(recheck);
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

  async function hello(message: Extract<ClientMessage, { type: 'hello' }>): Promise<void> {
    clearTimeout(helloTimer);
    if (message.v !== PROTOCOL_VERSION) return fail('version', `protocole ${PROTOCOL_VERSION} attendu`);
    if (typeof message.projectId !== 'string' || !ID_PATTERN.test(message.projectId)
      || typeof message.clientId !== 'string' || !ID_PATTERN.test(message.clientId)) {
      return fail('bad-request', 'ids');
    }
    projectId = message.projectId;
    const userId = await options.auth.verifyToken(message.token);
    if (!userId) return fail('unauthorized');
    const access = await options.auth.checkAccess(userId, message.projectId);
    if (access !== 'ok') return fail(access);
    if (phase !== 'joining') return;

    let room: HostedRoom | null = null;
    for (let attempt = 0; attempt < 2 && (!room || room.closed); attempt += 1) {
      room = await options.host.open(message.projectId, options.acceptSeed ? message.seed : undefined);
      if (!room) return fail('not-found');
    }
    if (!room || room.closed) return fail('busy', 'room-closing');
    if (phase !== 'joining') return;

    hosted = room;
    handle = {
      peer: { clientId: message.clientId, userId, send },
      close: (code, reason) => close(code, reason),
    };
    phase = 'joined';
    room.attach(handle, { epoch: message.epoch ?? null, lastSeq: message.lastSeq ?? null, presence: message.presence });
    // Seulement l'id : le message (et un éventuel document de départ) n'est pas gardé avec la connexion.
    const joinedProjectId = message.projectId;
    const joined = room;
    recheck = setInterval(() => {
      options.auth.checkAccess(userId, joinedProjectId).then((result) => {
        // Projet supprimé : toute la salle est fermée (4404) et purgée ;
        // accès retiré : seulement cette connexion (4403).
        if (result === 'not-found') joined.projectDeleted('revérification des droits');
        else if (result !== 'ok') fail('forbidden', 'access-revoked');
      }, (error: unknown) => options.log('warn', 'revérification des droits impossible', { error: String(error) }));
    }, ACCESS_RECHECK_MS);
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
        options.log('error', 'connexion à la salle impossible', { error: String(error) });
        fail('internal', 'room-unavailable');
      });
      return;
    }
    // Rien n'est envoyé avant `welcome` (le client attend) : ignoré pendant l'entrée.
    if (phase !== 'joined' || !hosted || !handle) return;
    hosted.handle(handle, message);
  });

  socket.on('close', () => close(1000, 'closed'));
  socket.on('error', () => close(1011, 'socket-error'));
}
