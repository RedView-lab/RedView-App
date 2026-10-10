import { deepEqual } from '@/features/itineraryPanel/lib/project/deepEqual';

import { isRouteHeader } from '../model/diff';
import { ObjectStore } from '../model/objects';
import { applyOps, applyOpsWithInverse, type Op } from '../model/ops';
import { MAX_OPS_PER_BATCH } from '../model/validate';
import { deserializeStore, type ClientMessage, type SequencedBatch, type ServerMessage } from '../protocol';

/**
 * Moteur de synchronisation d'un client (modèle de Figma) :
 *  - état confirmé : celui du serveur, à la séquence N (lots appliqués dans
 *    l'ordre du serveur, y compris les siens une fois acquittés) ;
 *  - modifications locales en attente : appliquées tout de suite à l'état
 *    visible, regroupées en lots numérotés (`clientSeq`) puis envoyées ;
 *  - état visible = confirmé + modifications en attente rejouées par-dessus.
 *    Une valeur distante sur une propriété que ce client vient de modifier
 *    est donc masquée jusqu'à l'acquittement de la sienne (pas de
 *    clignotement), puis l'ordre du serveur tranche.
 *
 * Les lots acquittés mais pas encore durables (journal du serveur) sont
 * gardés : si le serveur s'arrête avant de les écrire, ils sont renvoyés à la
 * reconnexion. Aucune entrée/sortie ici : la connexion (connection.ts) et le
 * simulateur de tests branchent leurs messages.
 *
 * Hors ligne, les opérations s'ajoutent au dernier lot jamais envoyé
 * (borné) au lieu d'en ouvrir un par image : une longue édition sans réseau
 * repart en quelques lots, sous le débit permis par le serveur, et sa copie
 * sur l'appareil reste petite. Un lot déjà parti sur une connexion n'est plus
 * jamais modifié (le serveur l'a peut-être appliqué).
 *
 * Avant le premier `welcome`, l'état confirmé est provisoire
 * (`seedProvisional` : le document affiché à l'ouverture, qui peut dater du
 * dernier point de sauvegarde). Les modifications de l'utilisateur s'y
 * appliquent comme des lots en attente, rejoués sur l'état du serveur dès
 * qu'il arrive puis envoyés ; les résultats calculés sur cette base
 * (`sendable: false`) restent locaux et disparaissent avec elle : envoyés,
 * ils écraseraient ceux de la session.
 */

interface LocalBatch {
  clientSeq: number;
  ops: Op[];
  /** Séquence serveur, une fois acquitté. */
  seq?: number;
  /** Calculé sur l'état provisoire : jamais envoyé, retiré au premier `welcome`. */
  localOnly?: true;
  /** Parti sur une connexion (ou repris d'une session précédente) : plus jamais modifié. */
  transmitted?: true;
}

/** Lot hors ligne : on y ajoute les opérations suivantes jusqu'à cette taille. */
const COALESCE_MAX_OPS = 2_000;
const COALESCE_MAX_CHARS = 1_000_000;

/** Lot pas encore écrit par le serveur, avec ses segments : de quoi le renvoyer depuis une autre session. */
export interface UnsyncedBatch {
  clientSeq: number;
  ops: Op[];
  blobs: Record<string, string>;
}

export type ReceiveOutcome =
  /** L'état visible a changé : document à rematérialiser. */
  | 'changed'
  | 'unchanged'
  /** Message incohérent (séquence manquante) : se reconnecter pour repartir d'un état sûr. */
  | 'resync';

export interface Rejection {
  clientSeq: number;
  reason: string;
}

export class SyncEngine {
  readonly clientId: string;
  private confirmed = new ObjectStore();
  private confirmedSeq = 0;
  private epochId: string | null = null;
  private durable = 0;
  private visibleStore = new ObjectStore();
  /** Opérations locales pas encore regroupées en lot. */
  private queued: Op[] = [];
  /** Lots en attente d'acquittement (envoyés ou non), dans l'ordre. */
  private pending: LocalBatch[] = [];
  /** Lots acquittés, pas encore durables côté serveur. */
  private undurable: LocalBatch[] = [];
  private nextClientSeq = 1;
  /** Dernier lot envoyé sur la connexion courante. */
  private sentUpTo = 0;
  /** Segments de tracé connus de ce client (jamais purgés pendant la session : l'annuler peut les redemander). */
  private readonly library = new Map<string, string>();
  private ready = false;
  private needsRebuild = false;
  private readonly rejections: Rejection[] = [];

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  /** État affiché (confirmé + en attente). */
  get visible(): ObjectStore {
    return this.visibleStore;
  }

  /** Premier état reçu du serveur. */
  get isReady(): boolean {
    return this.ready;
  }

  get seq(): number {
    return this.confirmedSeq;
  }

  get epoch(): string | null {
    return this.epochId;
  }

  get durableSeq(): number {
    return this.durable;
  }

  /** Modifications locales pas encore acquittées par le serveur. */
  get unsyncedCount(): number {
    return this.pending.filter((batch) => !batch.localOnly).length + (this.queued.length > 0 ? 1 : 0);
  }

  /** Tous les lots de ce client sont écrits par le serveur (acquittés ET durables). */
  get fullySynced(): boolean {
    return this.unsyncedCount === 0 && this.undurable.length === 0;
  }

  /** Des lots attendent encore d'être envoyés sur la connexion courante. */
  get hasUnsent(): boolean {
    return this.queued.length > 0 || this.pending.some((batch) => batch.clientSeq > this.sentUpTo && !batch.localOnly);
  }

  /** Prochain numéro de lot (gardé avec les lots non écrits). */
  get nextSeq(): number {
    return this.nextClientSeq;
  }

  /** Refus du serveur depuis le dernier appel (anomalies : journalisées par l'appelant). */
  takeRejections(): Rejection[] {
    return this.rejections.splice(0);
  }

  /** Champs de `hello` : reprise à partir de l'état confirmé. */
  resumePoint(): { epoch: string | null; lastSeq: number | null } {
    return this.ready ? { epoch: this.epochId, lastSeq: this.confirmedSeq } : { epoch: null, lastSeq: null };
  }

  /**
   * État confirmé provisoire, avant le premier `welcome` (document affiché à
   * l'ouverture) ; les lots déjà en attente (`restoreUnsynced`) sont rejoués
   * par-dessus.
   */
  seedProvisional(store: ObjectStore): void {
    if (this.ready) throw new Error('SyncEngine: état du serveur déjà reçu');
    for (const id of store.blobIds()) this.library.set(id, store.getBlob(id)!);
    this.confirmed = store;
    this.rebuild();
  }

  /**
   * Lots d'une session précédente de ce client (onglet fermé avant que le
   * serveur ne les écrive), avant le premier `welcome` : rejoués sur l'état
   * visible, puis renvoyés ; `welcome.clientSeq` écarte ceux que le serveur a
   * déjà appliqués.
   */
  restoreUnsynced(batches: readonly UnsyncedBatch[], nextClientSeq: number): void {
    if (this.ready) throw new Error('SyncEngine: état du serveur déjà reçu');
    for (const batch of batches) {
      for (const [id, json] of Object.entries(batch.blobs)) this.library.set(id, json);
      // Peut-être déjà reçu par le serveur (welcome.clientSeq le dira) : jamais fusionné.
      this.pending.push({ clientSeq: batch.clientSeq, ops: batch.ops, transmitted: true });
      this.nextClientSeq = Math.max(this.nextClientSeq, batch.clientSeq + 1);
    }
    this.pending.sort((a, b) => a.clientSeq - b.clientSeq);
    this.nextClientSeq = Math.max(this.nextClientSeq, nextClientSeq);
    this.needsRebuild = true;
  }

  /**
   * Empreinte de `unsyncedBatches()` (lots immuables une fois numérotés) :
   * inchangée, inutile de récrire la copie de l'appareil.
   */
  unsyncedSignature(): string {
    const batches = [...this.undurable, ...this.pending.filter((batch) => !batch.localOnly)];
    // Nombre d'opérations : un lot hors ligne grandit sans changer de numéro.
    const ops = batches.reduce((count, batch) => count + batch.ops.length, 0);
    return `${this.nextClientSeq}|${this.queued.length}|${batches.map((batch) => batch.clientSeq).join(',')}|${ops}`;
  }

  /**
   * Lots que le serveur n'a peut-être pas encore écrits (en attente, ou
   * acquittés mais pas durables), avec leurs segments : gardés sur l'appareil
   * pour survivre à la fermeture de l'onglet.
   */
  unsyncedBatches(): UnsyncedBatch[] {
    this.seal();
    return [...this.undurable, ...this.pending.filter((batch) => !batch.localOnly)]
      .sort((a, b) => a.clientSeq - b.clientSeq)
      .map((batch) => ({ clientSeq: batch.clientSeq, ops: batch.ops, blobs: this.referencedLibraryBlobs(batch.ops) }));
  }

  /**
   * Modification locale (opérations calculées sur l'état visible) ; renvoie
   * celles qui ont eu un effet et leur inverse (pour l'annuler).
   * `sendable: false` (avant le premier `welcome` seulement) : gardée
   * localement, jamais envoyée.
   */
  applyLocal(
    ops: readonly Op[],
    blobs: ReadonlyMap<string, string>,
    { sendable = true }: { sendable?: boolean } = {},
  ): { applied: Op[]; inverse: Op[] } {
    for (const [id, json] of blobs) this.library.set(id, json);
    // Segments fournis, ou déjà connus (annuler qui remet un ancien tracé).
    for (const id of referencedBlobs(ops)) {
      const json = this.library.get(id);
      if (json !== undefined) this.visibleStore.putBlob(id, json);
    }
    const result = applyOpsWithInverse(this.visibleStore, ops);
    if (result.applied.length === 0) return result;
    if (sendable || this.ready) {
      this.queued.push(...result.applied);
    } else {
      // Lot à part, à sa place parmi les autres : l'état visible reste exact.
      this.seal();
      this.pending.push({ clientSeq: this.nextClientSeq, ops: result.applied, localOnly: true });
      this.nextClientSeq += 1;
    }
    return result;
  }

  /**
   * Regroupe les opérations locales en lots (appelé ≈ 30 fois par seconde,
   * même hors ligne). `coalesce` (hors ligne) : ajoutées au dernier lot jamais
   * envoyé tant qu'il reste petit et sans segment de tracé (un lot avec des
   * segments est déjà gros : il reste seul).
   */
  seal(coalesce = false): void {
    if (this.queued.length === 0) return;
    const last = this.pending[this.pending.length - 1];
    if (
      coalesce && last && !last.transmitted && !last.localOnly
      && last.clientSeq > this.sentUpTo
      && last.ops.length + this.queued.length <= COALESCE_MAX_OPS
      && referencedBlobs(last.ops).size === 0 && referencedBlobs(this.queued).size === 0
      && opsChars(last.ops) + opsChars(this.queued) <= COALESCE_MAX_CHARS
    ) {
      // Nouveau tableau : la copie sur l'appareil en cours d'écriture garde le sien.
      this.pending[this.pending.length - 1] = { ...last, ops: [...last.ops, ...this.queued.splice(0)] };
      return;
    }
    while (this.queued.length > 0) {
      const ops = this.queued.splice(0, MAX_OPS_PER_BATCH);
      this.pending.push({ clientSeq: this.nextClientSeq, ops });
      this.nextClientSeq += 1;
    }
  }

  /**
   * Lots à envoyer sur la connexion courante (seulement une fois l'état reçu),
   * au plus `limit` (le reste au prochain envoi : débit permis par le serveur).
   */
  outgoing(limit = Number.POSITIVE_INFINITY): ClientMessage[] {
    if (!this.ready) return [];
    this.seal();
    const messages: ClientMessage[] = [];
    for (const batch of this.pending) {
      if (messages.length >= limit) break;
      if (batch.clientSeq <= this.sentUpTo || batch.localOnly) continue;
      batch.transmitted = true;
      messages.push({ type: 'batch', clientSeq: batch.clientSeq, ops: batch.ops, blobs: this.blobsFor(batch.ops) });
      this.sentUpTo = batch.clientSeq;
    }
    return messages;
  }

  /** Connexion perdue : les lots non acquittés seront renvoyés après le prochain `welcome`. */
  disconnected(): void {
    this.sentUpTo = 0;
  }

  receive(message: ServerMessage): ReceiveOutcome {
    switch (message.type) {
      case 'welcome':
        this.welcome(message);
        break;
      case 'batch':
        if (!this.ready) return 'unchanged';
        if (this.applyServerBatch(message.batch) === 'gap') return 'resync';
        break;
      case 'durable':
        this.durable = Math.max(this.durable, message.seq);
        this.undurable = this.undurable.filter((batch) => (batch.seq ?? 0) > this.durable);
        return 'unchanged';
      case 'duplicate': {
        // Déjà appliqué par le serveur : son acquittement est arrivé ou arrivera par l'état.
        const index = this.pending.findIndex((batch) => batch.clientSeq === message.clientSeq);
        if (index >= 0) {
          const [batch] = this.pending.splice(index, 1);
          this.undurable.push({ ...batch, seq: this.confirmedSeq });
          this.needsRebuild = true;
        }
        break;
      }
      case 'reject': {
        const index = this.pending.findIndex((batch) => batch.clientSeq === message.clientSeq);
        if (index >= 0) {
          this.pending.splice(index, 1);
          this.rejections.push({ clientSeq: message.clientSeq, reason: message.reason });
          this.needsRebuild = true;
        }
        break;
      }
      default:
        return 'unchanged';
    }
    return this.needsRebuild ? (this.rebuild() ? 'changed' : 'unchanged') : 'unchanged';
  }

  private welcome(message: Extract<ServerMessage, { type: 'welcome' }>): void {
    this.seal();
    // L'état provisoire est remplacé : ce qui a été calculé dessus disparaît avec lui.
    if (!this.ready) this.pending = this.pending.filter((batch) => !batch.localOnly);
    const sameEpoch = message.epoch === this.epochId;
    this.epochId = message.epoch;
    const mine = [...this.undurable, ...this.pending].sort((a, b) => a.clientSeq - b.clientSeq);
    if (message.snapshot) {
      this.confirmed = deserializeStore(message.snapshot);
      for (const [id, json] of Object.entries(message.snapshot.blobs)) this.library.set(id, json);
      this.confirmedSeq = message.snapshot.seq;
      // Lots déjà appliqués par le serveur (compris dans l'état) ; les autres sont renvoyés.
      this.undurable = mine
        .filter((batch) => batch.clientSeq <= message.clientSeq)
        .map((batch) => ({ ...batch, seq: sameEpoch && batch.seq !== undefined ? batch.seq : message.seq }));
      this.pending = mine.filter((batch) => batch.clientSeq > message.clientSeq);
    } else {
      for (const batch of message.catchUp ?? []) this.applyServerBatch(batch);
      const applied = this.pending.filter((batch) => batch.clientSeq <= message.clientSeq);
      this.pending = this.pending.filter((batch) => batch.clientSeq > message.clientSeq);
      this.undurable.push(...applied.map((batch) => ({ ...batch, seq: message.seq })));
    }
    this.durable = message.durableSeq;
    this.undurable = this.undurable.filter((batch) => (batch.seq ?? 0) > this.durable);
    this.nextClientSeq = Math.max(this.nextClientSeq, message.clientSeq + 1);
    this.sentUpTo = message.clientSeq;
    this.ready = true;
    this.needsRebuild = true;
  }

  private applyServerBatch(batch: SequencedBatch): 'stale' | 'gap' | 'applied' {
    if (batch.seq <= this.confirmedSeq) return 'stale';
    if (batch.seq !== this.confirmedSeq + 1) return 'gap';
    for (const [id, json] of Object.entries(batch.blobs)) {
      this.library.set(id, json);
      this.confirmed.putBlob(id, json);
    }
    // Son propre lot revient sans segments (`hello.leanEcho`) : ce client les a envoyés, ils
    // sont dans sa bibliothèque (le serveur a vérifié leur empreinte, qui est leur identifiant).
    if (batch.clientId === this.clientId) {
      for (const id of referencedBlobs(batch.ops)) {
        if (this.confirmed.hasBlob(id)) continue;
        const json = this.library.get(id);
        if (json !== undefined) this.confirmed.putBlob(id, json);
      }
    }
    applyOps(this.confirmed, batch.ops);
    this.confirmedSeq = batch.seq;
    if (batch.clientId === this.clientId) {
      const index = this.pending.findIndex((local) => local.clientSeq === batch.clientSeq);
      if (index >= 0) {
        const [local] = this.pending.splice(index, 1);
        this.undurable.push({ ...local, seq: batch.seq });
        // Acquittement à l'identique du premier lot en attente : l'état visible
        // (confirmé + en attente) ne change pas.
        if (index !== 0 || !deepEqual(local.ops, batch.ops)) this.needsRebuild = true;
        return 'applied';
      }
    }
    this.needsRebuild = true;
    return 'applied';
  }

  /** État visible = confirmé + en attente ; renvoie true s'il a changé. */
  private rebuild(): boolean {
    this.needsRebuild = false;
    const previous = this.visibleStore;
    const next = this.confirmed.clone();
    const pendingOps = [...this.pending.flatMap((batch) => batch.ops), ...this.queued];
    for (const id of referencedBlobs(pendingOps)) {
      const json = this.library.get(id);
      if (json !== undefined) next.putBlob(id, json);
    }
    applyOps(next, pendingOps);
    next.adoptEqual(previous);
    // L'état confirmé reprend les objets que les modifications en attente
    // n'ont pas touchés (même contenu) : la prochaine reconstruction n'aura
    // rien à comparer pour eux.
    const touched = touchedWithAncestors(pendingOps, this.confirmed, next);
    this.confirmed.shareObjects(next, (id) => !touched.has(id));
    this.visibleStore = next;
    return next.root() !== previous.root();
  }

  /** Tous les segments référencés par les opérations (connus de ce client). */
  private referencedLibraryBlobs(ops: readonly Op[]): Record<string, string> {
    const blobs: Record<string, string> = {};
    for (const id of referencedBlobs(ops)) {
      const json = this.library.get(id);
      if (json !== undefined) blobs[id] = json;
    }
    return blobs;
  }

  /** Segments référencés par les opérations et inconnus du serveur (état confirmé). */
  private blobsFor(ops: readonly Op[]): Record<string, string> {
    const blobs: Record<string, string> = {};
    for (const id of referencedBlobs(ops)) {
      if (this.confirmed.hasBlob(id)) continue;
      const json = this.library.get(id);
      if (json !== undefined) blobs[id] = json;
    }
    return blobs;
  }
}

/** Taille approximative des valeurs écrites (borne d'un lot hors ligne). */
function opsChars(ops: readonly Op[]): number {
  let chars = 0;
  for (const op of ops) {
    chars += 48 + op.id.length;
    if (op.t === 's' && 'v' in op) chars += valueChars(op.v);
    else if (op.t === 'c') for (const [key, value] of op.props) chars += key.length + valueChars(value);
  }
  return chars;
}

function valueChars(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return value.length + 2;
  if (typeof value !== 'object') return 8;
  return JSON.stringify(value)?.length ?? 4;
}

function referencedBlobs(ops: readonly Op[]): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (!isRouteHeader(value)) return;
    for (const id of value.points) ids.add(id);
    for (const id of value.originalPoints ?? []) ids.add(id);
  };
  for (const op of ops) {
    if (op.t === 's' && 'v' in op) add(op.v);
    else if (op.t === 'c') for (const [, value] of op.props) add(value);
  }
  return ids;
}

function touchedWithAncestors(ops: readonly Op[], ...stores: ObjectStore[]): Set<string> {
  const touched = new Set<string>();
  const addChain = (id: string | null) => {
    let current = id;
    while (current && !touched.has(current)) {
      touched.add(current);
      let parent: string | null = null;
      for (const store of stores) {
        const object = store.get(current);
        if (object) {
          parent = object.parent;
          break;
        }
      }
      current = parent;
    }
  };
  for (const op of ops) {
    addChain(op.id);
    if (op.t === 'c') addChain(op.parent);
  }
  return touched;
}
