/**
 * Processus de clients du test de charge (enfant de run.ts) : toutes les
 * connexions d'une tranche de salles, pour que le générateur de charge ne
 * soit pas le goulot (un seul processus compressait et décompressait pour
 * 250 connexions : à 50 salles, c'est lui qui saturait). Une salle entière
 * vit dans un processus : envoi et réception d'un lot se mesurent sur la même
 * horloge. Piloté par IPC : `config` → `seeded` (premier client de chaque
 * salle connecté, salle créée) → `open` → `opened` → `start` → `stop` →
 * `results` → [`storm-arm` → `armed`, `storm-status` → `storm`] →
 * `close` → `closed`.
 *
 * Tempête (`storm-arm`) : fermé par le serveur en 1012 (redémarrage), chaque
 * client revient comme CollabConnection — 300 ms + 0 à 1,2 s, puis nouvel
 * essai 250 à 500 ms plus tard tant que la connexion est refusée — et note
 * le temps jusqu'à son `welcome` et la taille de celui-ci sur le fil.
 */
import { inflateRawSync } from 'node:zlib';

import { WebSocket, type ClientOptions } from 'ws';

import { itineraryObjectId } from '../../src/features/collab/model/paths.ts';
import { PROTOCOL_VERSION, socketProtocols, type ServerMessage } from '../../src/features/collab/protocol.ts';
import { sampleDocument } from '../../src/features/collab/sim/fixtures.ts';

export interface ClientsConfig {
  port: number;
  /** Salles de ce processus : [from, to). */
  from: number;
  to: number;
  clients: number;
  rate: number;
  route: number;
  motionHz: number;
  motionShare: number;
  deflate: ClientOptions['perMessageDeflate'];
}

export interface ClientsResults {
  broadcast: number[];
  acks: number[];
  motionRelay: number[];
  batchesSent: number;
  motionSent: number;
  received: number;
  rejected: number;
}

export interface StormStatus {
  total: number;
  rejoined: number;
  /** Fermeture 1012 → `welcome` de la nouvelle connexion (ms). */
  rejoinMs: number[];
  /** Taille du `welcome` sur le fil (octets) et s'il était compressé. */
  welcomeBytes: number[];
  welcomeCompressed: number;
  attempts: number;
}

let config: ClientsConfig;
let document: ReturnType<typeof sampleDocument>;
const sentAt = new Map<string, number>();
const results: ClientsResults = { broadcast: [], acks: [], motionRelay: [], batchesSent: 0, motionSent: 0, received: 0, rejected: 0 };
const storm: StormStatus = { total: 0, rejoined: 0, rejoinMs: [], welcomeBytes: [], welcomeCompressed: 0, attempts: 0 };
let stormArmed = false;

class LoadClient {
  readonly clientId: string;
  private readonly projectId: string;
  private readonly seed: boolean;
  private socket: WebSocket | null = null;
  private clientSeq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private motionTimer: ReturnType<typeof setInterval> | null = null;
  /** Ce client est suivi (ou présente) : caméra + pointeur à `motionHz`. */
  private readonly sendsMotion: boolean;
  /** Tempête : fermé en 1012 à cet instant, `welcome` de retour attendu. */
  private closedAt: number | null = null;

  constructor(room: number, index: number) {
    this.projectId = `load-${room}`;
    this.clientId = `load-${room}-${index}`;
    this.seed = index === 0;
    this.sendsMotion = config.motionHz > 0 && index < Math.round(config.clients * config.motionShare);
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${config.port}/multiplayer?project=${this.projectId}`,
        socketProtocols(`dev:${this.clientId}`),
        { perMessageDeflate: config.deflate },
      );
      this.socket = socket;
      socket.on('open', () => socket.send(JSON.stringify({
        type: 'hello',
        v: PROTOCOL_VERSION,
        clientId: this.clientId,
        epoch: null,
        lastSeq: null,
        // Comme l'application : les gros messages (état complet) arrivent compressés (wire.ts).
        compress: true,
        ...(this.seed ? { seed: document } : {}),
      })));
      socket.on('message', (data, isBinary) => {
        const now = performance.now();
        const message = JSON.parse(isBinary ? inflateRawSync(data as Buffer).toString() : String(data)) as ServerMessage;
        results.received += 1;
        if (message.type === 'welcome') {
          if (this.closedAt !== null) {
            storm.rejoined += 1;
            storm.rejoinMs.push(now - this.closedAt);
            storm.welcomeBytes.push((data as Buffer).length);
            if (isBinary) storm.welcomeCompressed += 1;
            this.closedAt = null;
          }
          resolve();
        } else if (message.type === 'batch') {
          const at = sentAt.get(`${message.batch.clientId}#${message.batch.clientSeq}`);
          if (at !== undefined) (message.batch.clientId === this.clientId ? results.acks : results.broadcast).push(now - at);
        } else if (message.type === 'motion') results.motionRelay.push(now - message.t);
        else if (message.type === 'reject') results.rejected += 1;
      });
      socket.on('error', reject);
      socket.on('close', (code) => {
        if (!stormArmed || socket !== this.socket) return;
        if (code === 1012) {
          this.closedAt = performance.now();
          setTimeout(() => this.reconnect(), 300 + Math.random() * 1_200);
        } else if (this.closedAt !== null) {
          // Refusée pendant le redémarrage (serveur pas encore prêt) : nouvel essai.
          setTimeout(() => this.reconnect(), 250 + Math.random() * 250);
        }
      });
    });
  }

  private reconnect(): void {
    storm.attempts += 1;
    // Une connexion refusée lève `error` puis `close` : la reprise passe par `close`.
    this.open().catch(() => undefined);
  }

  start(): void {
    const ops = ['name', 'color', 'priorities.elevation'];
    const id = itineraryObjectId(this.clientId.endsWith('-0') ? 'it-1' : 'it-2');
    // Phase aléatoire : les clients n'envoient pas tous au même instant.
    setTimeout(() => {
      this.timer = setInterval(() => {
        this.clientSeq += 1;
        const key = ops[this.clientSeq % ops.length];
        // Valeurs qu'un client honnête écrit (le serveur refuse une couleur qui n'en est pas une).
        const value = key === 'priorities.elevation'
          ? this.clientSeq % 100
          : key === 'color' ? `#${(this.clientSeq * 2654435761 % 0xffffff).toString(16).padStart(6, '0')}` : `${this.clientId}-${this.clientSeq}`;
        sentAt.set(`${this.clientId}#${this.clientSeq}`, performance.now());
        results.batchesSent += 1;
        this.socket!.send(JSON.stringify({ type: 'batch', clientSeq: this.clientSeq, ops: [{ t: 's', id, k: key, v: value }], blobs: {} }));
      }, 1000 / config.rate);
    }, Math.random() * (1000 / config.rate));
    if (!this.sendsMotion) return;
    setTimeout(() => {
      let step = 0;
      this.motionTimer = setInterval(() => {
        step += 1;
        const x = (step % 600) / 600;
        results.motionSent += 1;
        this.socket!.send(JSON.stringify({
          type: 'motion',
          t: Math.round(performance.now() * 10) / 10,
          cam: [6.9 + 0.05 * x, 45.95 + 0.02 * x, 13, 360 * x - 180, 55, 36.87],
          vp: [1600, 900, 64, 360, 300, 420, 0, 0, 0, 0],
          ptr: [6.91 + 0.01 * x, 45.96],
        }));
      }, 1000 / config.motionHz);
    }, Math.random() * (1000 / config.motionHz));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.motionTimer) clearInterval(this.motionTimer);
  }

  close(): void {
    this.socket?.close(1000, 'done');
  }
}

const clients: LoadClient[] = [];

process.on('message', (message: { type: string; config?: ClientsConfig }) => {
  void (async () => {
    if (message.type === 'config') {
      config = message.config!;
      document = sampleDocument(config.route);
      // Le premier client crée la salle (document de départ) avant les autres.
      for (let room = config.from; room < config.to; room += 1) {
        for (let index = 0; index < config.clients; index += 1) {
          const client = new LoadClient(room, index);
          clients.push(client);
          if (index === 0) await client.open();
        }
      }
      process.send!({ type: 'seeded' });
    } else if (message.type === 'open') {
      await Promise.all(clients.map((client, index) => (index % config.clients === 0 ? Promise.resolve() : client.open())));
      process.send!({ type: 'opened' });
    } else if (message.type === 'start') {
      for (const client of clients) client.start();
    } else if (message.type === 'stop') {
      for (const client of clients) client.stop();
      // Fin : diffusion terminée.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      process.send!({ type: 'results', results });
    } else if (message.type === 'storm-arm') {
      stormArmed = true;
      storm.total = clients.length;
      process.send!({ type: 'armed' });
    } else if (message.type === 'storm-status') {
      process.send!({ type: 'storm', storm });
    } else if (message.type === 'close') {
      stormArmed = false;
      for (const client of clients) client.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
      process.send!({ type: 'closed' });
    }
  })();
});

process.on('disconnect', () => process.exit(0));
