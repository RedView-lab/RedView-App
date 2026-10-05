import type { DerivedKind } from '@/features/itineraryPanel/context/ProjectStore/collab';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { storeFromDocument } from '../model/diff';
import { Materializer } from '../model/materialize';
import type { ObjectStore } from '../model/objects';
import { applyOps, type Op } from '../model/ops';
import { decodePath, itineraryIdOf } from '../model/paths';
import { checkBatch } from '../model/validate';
import { DERIVED_INPUTS } from '../schema';
import type { SequencedBatch, Snapshot } from '../protocol';
import { serializeStore } from '../protocol';

/**
 * Cœur d'une salle (un projet ouvert en co-édition), sans réseau ni
 * stockage : utilisé tel quel par le serveur temps réel et par le simulateur
 * de tests. Le serveur fait foi :
 *  - chaque lot accepté reçoit le numéro de séquence suivant (ordre unique
 *    pour tous) ; un lot renvoyé après une reconnexion (même client, même
 *    numéro de lot) n'est jamais appliqué deux fois ;
 *  - un lot invalide est refusé en entier (model/validate.ts), y compris
 *    une écriture sur le commentaire d'un autre (model/commentRules.ts) ;
 *  - l'auteur de la dernière modification de chaque champ d'itinéraire est
 *    connu : c'est lui qui calcule les résultats dérivés (baux, cf. leases).
 */

export interface ClientBatchInput {
  clientId: string;
  clientSeq: number;
  ops: unknown;
  blobs: Readonly<Record<string, string>>;
}

export type BatchOutcome =
  | { kind: 'applied'; batch: SequencedBatch }
  | { kind: 'duplicate' }
  | { kind: 'rejected'; reason: string; missingBlobs?: string[] };

export interface FieldAuthor {
  clientId: string;
  userId: string;
  at: number;
}

/** Champ fictif : l'itinéraire lui-même (création, suppression, déplacement). */
const WHOLE_ITINERARY = '*';

/**
 * Derniers numéros de lot par client, gardés dans le point de sauvegarde :
 * un lot renvoyé après un arrêt du serveur (acquitté mais pas encore journalisé
 * de son point de vue) n'est jamais appliqué deux fois. Les plus anciens
 * clients sont oubliés au-delà de cette limite.
 */
const MAX_REMEMBERED_CLIENTS = 1024;

export class RoomState {
  readonly store: ObjectStore;
  private sequence: number;
  private readonly lastClientSeq = new Map<string, number>();
  private readonly authors = new Map<string, Map<string, FieldAuthor>>();

  constructor(store: ObjectStore, seq: number, clientSeqs: Readonly<Record<string, number>> = {}) {
    this.store = store;
    this.sequence = seq;
    for (const [clientId, clientSeq] of Object.entries(clientSeqs)) {
      if (Number.isSafeInteger(clientSeq)) this.lastClientSeq.set(clientId, clientSeq);
    }
  }

  /** Salle à partir du document enregistré (point de sauvegarde) et de sa séquence. */
  static fromDocument(
    document: ProjectDocument,
    seq: number,
    clientSeqs: Readonly<Record<string, number>> = {},
  ): RoomState {
    return new RoomState(storeFromDocument(document), seq, clientSeqs);
  }

  get seq(): number {
    return this.sequence;
  }

  /** Dernier lot appliqué de ce client (0 : aucun). */
  lastClientSeqOf(clientId: string): number {
    return this.lastClientSeq.get(clientId) ?? 0;
  }

  /** Numéros de lot par client, pour le point de sauvegarde. */
  clientSeqs(): Record<string, number> {
    return Object.fromEntries(this.lastClientSeq);
  }

  /** Applique le lot d'un client (validé, positions corrigées) et le numérote. */
  applyClientBatch(input: ClientBatchInput, userId: string, now: number): BatchOutcome {
    const last = this.lastClientSeq.get(input.clientId) ?? 0;
    if (input.clientSeq <= last) return { kind: 'duplicate' };
    const check = checkBatch(this.store, input.ops, input.blobs, { userId });
    if (!check.ok) return { kind: 'rejected', reason: check.reason, missingBlobs: check.missingBlobs };
    for (const [id, json] of Object.entries(input.blobs)) this.store.putBlob(id, json);
    this.recordAuthors(check.ops, { clientId: input.clientId, userId, at: now });
    applyOps(this.store, check.ops);
    this.rememberClientSeq(input.clientId, input.clientSeq);
    this.sequence += 1;
    return {
      kind: 'applied',
      batch: {
        seq: this.sequence,
        clientId: input.clientId,
        clientSeq: input.clientSeq,
        userId,
        ops: check.ops,
        blobs: { ...input.blobs },
      },
    };
  }

  /**
   * Rejoue un lot du journal (reprise après un arrêt) : déjà validé et
   * numéroté par le serveur qui l'a écrit.
   */
  replay(batch: SequencedBatch): void {
    if (batch.seq <= this.sequence) return;
    for (const [id, json] of Object.entries(batch.blobs)) this.store.putBlob(id, json);
    this.recordAuthors(batch.ops, { clientId: batch.clientId, userId: batch.userId, at: 0 });
    applyOps(this.store, batch.ops);
    this.rememberClientSeq(batch.clientId, Math.max(batch.clientSeq, this.lastClientSeqOf(batch.clientId)));
    this.sequence = batch.seq;
  }

  snapshot(): Snapshot {
    return serializeStore(this.store, this.sequence);
  }

  /** Document courant (rien n'est gardé : le serveur écrit le sien avec `materializeJson`). */
  document(): ProjectDocument {
    return new Materializer().materialize(this.store);
  }

  /** Dernier auteur d'une entrée du résultat `kind` de l'itinéraire. */
  lastInputAuthor(kind: DerivedKind, itineraryId: string): FieldAuthor | undefined {
    const fields = this.authors.get(itineraryId);
    if (!fields) return undefined;
    let latest = fields.get(WHOLE_ITINERARY);
    for (const field of DERIVED_INPUTS[kind]) {
      const author = fields.get(field);
      if (author && (!latest || author.at >= latest.at)) latest = author;
    }
    return latest;
  }

  /** Le client devient le plus récent ; les plus anciens sont oubliés au-delà de la limite. */
  private rememberClientSeq(clientId: string, clientSeq: number): void {
    this.lastClientSeq.delete(clientId);
    this.lastClientSeq.set(clientId, clientSeq);
    while (this.lastClientSeq.size > MAX_REMEMBERED_CLIENTS) {
      const oldest = this.lastClientSeq.keys().next().value!;
      this.lastClientSeq.delete(oldest);
    }
  }

  private recordAuthors(ops: readonly Op[], author: FieldAuthor): void {
    for (const op of ops) {
      const touched = touchedField(this.store, op);
      if (!touched) continue;
      let fields = this.authors.get(touched.itineraryId);
      if (!fields) {
        fields = new Map();
        this.authors.set(touched.itineraryId, fields);
      }
      fields.set(touched.field, author);
    }
  }
}

/** Itinéraire et champ (premier niveau de l'itinéraire) touchés par une opération. */
function touchedField(store: ObjectStore, op: Op): { itineraryId: string; field: string } | null {
  const itineraryId = itineraryIdOf(op.id);
  if (!itineraryId) return null;
  const itineraryPrefix = op.id.indexOf('/', op.id.indexOf('itineraries:'));
  const isItineraryObject = itineraryPrefix < 0;
  if (isItineraryObject) {
    if (op.t === 's') return { itineraryId, field: decodePath(op.k)[0] ?? WHOLE_ITINERARY };
    return { itineraryId, field: WHOLE_ITINERARY };
  }
  // Élément d'une liste de l'itinéraire : le champ est celui de la liste.
  const object = store.get(op.id);
  const field = op.t === 'c' ? op.field : object?.field ?? null;
  const rest = op.id.slice(itineraryPrefix + 1);
  const listField = field ?? rest.slice(0, rest.indexOf(':'));
  return { itineraryId, field: decodePath(listField)[0] ?? WHOLE_ITINERARY };
}
