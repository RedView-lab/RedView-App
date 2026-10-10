import { PROTOCOL_VERSION } from '../protocol';
import { CollabConnection, type CollabConnectionOptions } from './connection';
import type { CollabClient } from './collabClient';
import { UnsyncedCopyDrain, type CopyDrainOptions } from './copyDrain';
import {
  adoptAllUnsynced,
  deleteUnsynced,
  holdClientLock,
  unsyncedPersistenceSupported,
  writeUnsynced,
  type AdoptedUnsynced,
} from './unsyncedStore';

/**
 * Session de co-édition d'un projet dans cet onglet : la connexion (et son
 * client) plus la copie sur l'appareil des modifications que le serveur n'a
 * peut-être pas encore écrites (unsyncedStore.ts). Au démarrage, toutes les
 * copies laissées par des onglets fermés sont reprises : la plus récente
 * devient celle de la session (même client, lots renvoyés), les plus
 * anciennes sont renvoyées chacune par sa propre connexion (copyDrain.ts),
 * et les lots de la session attendent qu'elles soient écrites — l'ordre des
 * modifications est gardé, la plus récente l'emporte (C1-1). Ensuite chaque
 * changement est réécrit après une courte attente, tout de suite quand
 * l'onglet passe en arrière-plan ou se ferme, et la copie est supprimée quand
 * le serveur a tout écrit.
 */

export interface CollabSessionOptions extends Omit<CollabConnectionOptions, 'clientId' | 'onUnsyncedChange'> {
  /** Propriétaire des copies sur l'appareil (un autre compte ne les reprend jamais). */
  userId: string;
}

const WRITE_DELAY_MS = 250;
/**
 * Une fois la session en ligne, ses lots partent au plus tard après ce délai,
 * même si une copie plus ancienne n'est pas encore écrite (serveur qui la
 * refuse sans fermer, connexion de reprise bloquée).
 */
const DRAIN_HOLD_MAX_MS = 30_000;

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
  /** Reprise des copies plus anciennes (null : aucune) et celle en cours. */
  private drained: Promise<void> | null = null;
  private drain: UnsyncedCopyDrain | null = null;
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

  /**
   * Crée la session : la plus récente des copies d'onglets fermés adoptée
   * (les plus anciennes renvoyées avant ses lots), sinon nouveau client (verrouillé).
   */
  static async start(options: CollabSessionOptions): Promise<CollabSession> {
    if (!unsyncedPersistenceSupported()) return new CollabSession(options, globalThis.crypto.randomUUID(), null);
    const adopted = await adoptAllUnsynced(options.projectId, options.userId).catch((error: unknown) => {
      console.warn('[collab] modifications gardées sur l’appareil illisibles', error);
      return [];
    });
    const newest = adopted.pop();
    if (newest) {
      const session = new CollabSession(options, newest.record.clientId, newest.release);
      session.connection.client.engine.restoreUnsynced(newest.record.batches, newest.record.nextClientSeq);
      session.persistedSignature = session.connection.client.engine.unsyncedSignature();
      if (adopted.length > 0) session.drainOlderCopies(options, adopted);
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
    await this.drain?.stop();
    await this.drained;
    await this.writes;
    this.releaseLock?.();
    this.releaseLock = null;
  }

  /**
   * Copies plus anciennes : renvoyées une à une (la plus ancienne d'abord),
   * pendant que les lots de la session attendent. Session fermée avant la
   * fin : celles qui restent gardent leurs lots sur l'appareil.
   */
  private drainOlderCopies(options: CollabSessionOptions, copies: AdoptedUnsynced[]): void {
    const { userId: _userId, ...connectionOptions } = options;
    const drainOptions: CopyDrainOptions = connectionOptions;
    this.drained = (async () => {
      for (const copy of copies) {
        if (this.stopped) {
          copy.release();
          continue;
        }
        const drain = new UnsyncedCopyDrain(drainOptions, copy);
        this.drain = drain;
        await drain.done;
        this.drain = null;
      }
    })();
    this.client.holdOutgoing(Promise.race([this.drained, this.holdDeadline()]));
  }

  /** Résolue DRAIN_HOLD_MAX_MS après la première mise en ligne de la session. */
  private holdDeadline(): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const arm = () => {
        if (timer || this.client.getState().status !== 'online') return;
        unsubscribe();
        timer = setTimeout(resolve, DRAIN_HOLD_MAX_MS);
      };
      const unsubscribe = this.client.subscribeState(arm);
      arm();
      void this.drained?.then(() => {
        unsubscribe();
        if (timer) clearTimeout(timer);
      });
    });
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
