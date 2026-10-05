import { PROTOCOL_VERSION } from '../protocol';
import { CollabConnection, type CollabConnectionOptions } from './connection';
import type { CollabClient } from './collabClient';
import {
  adoptUnsynced,
  deleteUnsynced,
  holdClientLock,
  unsyncedPersistenceSupported,
  writeUnsynced,
} from './unsyncedStore';

/**
 * Session de co-édition d'un projet dans cet onglet : la connexion (et son
 * client) plus la copie sur l'appareil des modifications que le serveur n'a
 * peut-être pas encore écrites (unsyncedStore.ts). Au démarrage, la copie
 * laissée par un onglet fermé est adoptée (même client, lots renvoyés) ;
 * ensuite chaque changement est réécrit après une courte attente, tout de
 * suite quand l'onglet passe en arrière-plan ou se ferme, et la copie est
 * supprimée quand le serveur a tout écrit.
 */

export interface CollabSessionOptions extends Omit<CollabConnectionOptions, 'clientId' | 'onUnsyncedChange'> {
  /** Propriétaire des copies sur l'appareil (un autre compte ne les reprend jamais). */
  userId: string;
}

const WRITE_DELAY_MS = 250;

export class CollabSession {
  readonly connection: CollabConnection;
  private readonly projectId: string;
  private readonly userId: string;
  /** Verrou du client (null : pas de copie sur l'appareil possible). */
  private releaseLock: (() => void) | null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** Empreinte des lots tels qu'écrits sur l'appareil (cf. `SyncEngine.unsyncedSignature`). */
  private persistedSignature = '';
  private discarded = false;
  private stopped = false;
  private readonly onPageHide = () => this.persistNow();

  private constructor(options: CollabSessionOptions, clientId: string, releaseLock: (() => void) | null) {
    this.projectId = options.projectId;
    this.userId = options.userId;
    this.releaseLock = releaseLock;
    this.connection = new CollabConnection({
      ...options,
      clientId,
      onUnsyncedChange: () => this.schedulePersist(),
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.onPageHide);
      document.addEventListener('visibilitychange', this.onPageHide);
    }
  }

  /** Crée la session : copie d'un onglet fermé adoptée, sinon nouveau client (verrouillé). */
  static async start(options: CollabSessionOptions): Promise<CollabSession> {
    if (!unsyncedPersistenceSupported()) return new CollabSession(options, globalThis.crypto.randomUUID(), null);
    const adopted = await adoptUnsynced(options.projectId, options.userId).catch((error: unknown) => {
      console.warn('[collab] modifications gardées sur l’appareil illisibles', error);
      return null;
    });
    if (adopted) {
      const session = new CollabSession(options, adopted.record.clientId, adopted.release);
      session.connection.client.engine.restoreUnsynced(adopted.record.batches, adopted.record.nextClientSeq);
      session.persistedSignature = session.connection.client.engine.unsyncedSignature();
      return session;
    }
    const clientId = globalThis.crypto.randomUUID();
    return new CollabSession(options, clientId, await holdClientLock(clientId));
  }

  get client(): CollabClient {
    return this.connection.client;
  }

  /** Modifications locales que ni le serveur ni la copie de l'appareil ne gardent encore. */
  hasUnprotectedChanges(): boolean {
    if (this.client.getState().unsynced === 0) return false;
    return this.releaseLock === null || this.discarded
      || this.persistedSignature !== this.client.engine.unsyncedSignature();
  }

  /** Accès refusé ou projet supprimé : rien ne pourra plus être envoyé, la copie est abandonnée. */
  discardUnsynced(): void {
    if (this.discarded) return;
    this.discarded = true;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    this.enqueueWrite(() => deleteUnsynced(this.client.clientId));
  }

  /** Fin de session (projet fermé) : copie à jour, connexion fermée, verrou rendu (une autre session pourra la reprendre). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.persistNow();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onPageHide);
      document.removeEventListener('visibilitychange', this.onPageHide);
    }
    this.connection.stop();
    await this.writes;
    this.releaseLock?.();
    this.releaseLock = null;
  }

  private schedulePersist(): void {
    if (!this.releaseLock || this.discarded || this.stopped || this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persistNow();
    }, WRITE_DELAY_MS);
  }

  /** Écrit (ou supprime) la copie de l'appareil si les lots ont changé depuis la dernière écriture. */
  private persistNow(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (!this.releaseLock || this.discarded) return;
    const engine = this.client.engine;
    const signature = engine.unsyncedSignature();
    if (signature === this.persistedSignature) return;
    // Lus maintenant (état exact à cet instant), écrits dans l'ordre.
    const batches = engine.unsyncedBatches();
    const clientId = this.client.clientId;
    const record = {
      clientId,
      projectId: this.projectId,
      userId: this.userId,
      protocol: PROTOCOL_VERSION,
      nextClientSeq: engine.nextSeq,
      batches,
      savedAt: Date.now(),
    };
    this.enqueueWrite(async () => {
      if (batches.length === 0) await deleteUnsynced(clientId);
      else await writeUnsynced(record);
      this.persistedSignature = signature;
    });
  }

  private enqueueWrite(write: () => Promise<void>): void {
    this.writes = this.writes.then(write).catch((error: unknown) => {
      console.warn('[collab] copie des modifications sur l’appareil impossible', error);
    });
  }
}
