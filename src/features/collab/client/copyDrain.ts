import { CollabConnection, type CollabConnectionOptions } from './connection';
import { deleteUnsynced, writeUnsynced, type AdoptedUnsynced } from './unsyncedStore';

/**
 * Copie plus ancienne d'un autre onglet fermé, reprise en même temps que celle
 * de la session (session.ts) : renvoyée par une connexion à elle, avec son
 * propre `clientId` (le serveur écarte les lots qu'il a déjà, `welcome.clientSeq`),
 * puis supprimée de l'appareil une fois tout écrit par le serveur. Rien n'est
 * affiché : son document n'est jamais branché sur le store.
 *
 * Sans suite possible (session fermée, refus passager) : les lots restants
 * sont réécrits sur l'appareil, à reprendre la prochaine fois. Accès retiré ou
 * projet supprimé : abandonnés, comme ceux de la session.
 */

export type CopyDrainOptions = Omit<CollabConnectionOptions, 'clientId' | 'onUnsyncedChange'>;

export class UnsyncedCopyDrain {
  /** Résolue quand la copie est écrite, abandonnée ou remise sur l'appareil. */
  readonly done: Promise<void>;
  private readonly connection: CollabConnection;
  private readonly copy: AdoptedUnsynced;
  private readonly unsubscribe: () => void;
  private finished = false;
  private resolveDone!: () => void;

  constructor(options: CopyDrainOptions, copy: AdoptedUnsynced) {
    this.copy = copy;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.connection = new CollabConnection({
      ...options,
      clientId: copy.record.clientId,
      onUnsyncedChange: () => this.check(),
    });
    this.connection.client.engine.restoreUnsynced(copy.record.batches, copy.record.nextClientSeq);
    this.unsubscribe = this.connection.client.subscribeState(() => this.check());
    this.connection.start();
  }

  get clientId(): string {
    return this.copy.record.clientId;
  }

  /** Session fermée : les lots pas encore écrits retournent sur l'appareil. */
  stop(): Promise<void> {
    if (!this.finished) void this.finish('keep');
    return this.done;
  }

  private check(): void {
    if (this.finished) return;
    const client = this.connection.client;
    const state = client.getState();
    if (state.ready && client.engine.fullySynced) {
      void this.finish('written');
    } else if (state.status === 'denied') {
      const gone = state.deniedReason === 'forbidden' || state.deniedReason === 'not-found';
      void this.finish(gone ? 'discard' : 'keep');
    }
  }

  private async finish(outcome: 'written' | 'discard' | 'keep'): Promise<void> {
    this.finished = true;
    this.unsubscribe();
    const engine = this.connection.client.engine;
    const batches = outcome === 'keep' ? engine.unsyncedBatches() : [];
    const nextClientSeq = engine.nextSeq;
    this.connection.stop();
    const { record, release } = this.copy;
    try {
      // Date d'origine gardée : à la prochaine reprise, elle reste derrière les copies plus récentes.
      if (batches.length > 0) await writeUnsynced({ ...record, batches, nextClientSeq });
      else await deleteUnsynced(record.clientId);
    } catch (error) {
      console.warn('[collab] copie d’un onglet fermé : mise à jour sur l’appareil impossible', error);
    }
    release();
    this.resolveDone();
  }
}
