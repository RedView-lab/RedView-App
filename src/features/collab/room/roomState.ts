import type { DerivedKind } from '@/features/itineraryPanel/context/ProjectStore/collab';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { storeFromDocument } from '../model/diff';
import { Materializer } from '../model/materialize';
import type { ObjectStore } from '../model/objects';
import { applyOps, type Op } from '../model/ops';
import { decodePath, itineraryIdOf, itineraryObjectId } from '../model/paths';
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
 *    connu : c'est lui qui calcule les résultats dérivés (baux, cf. leases) ;
 *  - un `clientId` appartient à l'utilisateur qui l'a utilisé le premier
 *    (gardé avec les numéros de lot) : un autre éditeur qui le reprendrait
 *    ferait passer les lots de son vrai titulaire pour des doublons ;
 *  - la taille d'une salle est bornée (`MAX_ROOM_CHARS`, ≈ JSON de son
 *    point de sauvegarde, segments périmés compris) : au-delà, seuls de
 *    petits lots passent encore (supprimer, renommer).
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

/** Taille maximale d'une salle (caractères JSON ; un projet du cloud fait ≤ 100 M une fois décompressé). */
export const MAX_ROOM_CHARS = 150_000_000;
/** Un lot plus petit passe toujours (une salle pleine reste modifiable : supprimer, renommer). */
const ALWAYS_ACCEPTED_BATCH_CHARS = 64 * 1024;

function valueChars(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return value.length + 2;
  if (typeof value !== 'object') return 8;
  return JSON.stringify(value)?.length ?? 4;
}

/** Taille approximative (caractères JSON) des opérations et segments d'un lot. */
export function estimateBatchChars(ops: readonly Op[], blobs: Readonly<Record<string, string>>): number {
  let chars = 160;
  for (const op of ops) {
    chars += 48 + op.id.length;
    if (op.t === 's') chars += op.k.length + ('v' in op ? valueChars(op.v) : 0);
    else if (op.t === 'c') for (const [key, value] of op.props) chars += key.length + valueChars(value);
  }
  for (const json of Object.values(blobs)) chars += json.length;
  return chars;
}

/** Taille approximative d'un magasin (objets et segments), comme le JSON de son point de sauvegarde. */
function estimateStoreChars(store: ObjectStore): number {
  let chars = 0;
  for (const object of store.values()) {
    chars += 64 + object.id.length;
    for (const [key, value] of object.props) chars += key.length + valueChars(value);
  }
  for (const id of store.blobIds()) chars += id.length + store.getBlob(id)!.length;
  return chars;
}

export class RoomState {
  readonly store: ObjectStore;
  private sequence: number;
  private readonly lastClientSeq = new Map<string, number>();
  /** Titulaire (utilisateur) de chaque `clientId` connu. */
  private readonly clientUsers = new Map<string, string>();
  private readonly authors = new Map<string, Map<string, FieldAuthor>>();
  /** Taille approximative (cf. `MAX_ROOM_CHARS`), calculée au premier lot ; -1 : pas encore. */
  private sizeChars = -1;

  constructor(
    store: ObjectStore,
    seq: number,
    clientSeqs: Readonly<Record<string, number>> = {},
    clientUsers: Readonly<Record<string, string>> = {},
  ) {
    this.store = store;
    this.sequence = seq;
    for (const [clientId, clientSeq] of Object.entries(clientSeqs)) {
      if (Number.isSafeInteger(clientSeq)) this.lastClientSeq.set(clientId, clientSeq);
    }
    for (const [clientId, userId] of Object.entries(clientUsers)) {
      if (typeof userId === 'string') this.clientUsers.set(clientId, userId);
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

  /** Titulaire de chaque client, pour le point de sauvegarde. */
  clientUserMap(): Record<string, string> {
    return Object.fromEntries(this.clientUsers);
  }

  /** Utilisateur titulaire de `clientId` (undefined : jamais vu). */
  clientOwner(clientId: string): string | undefined {
    return this.clientUsers.get(clientId);
  }

  /** Taille connue exactement (JSON du point de sauvegarde qui vient d'être écrit). */
  setSizeChars(chars: number): void {
    this.sizeChars = chars;
  }

  /** Applique le lot d'un client (validé, positions corrigées) et le numérote. */
  applyClientBatch(input: ClientBatchInput, userId: string, now: number): BatchOutcome {
    const owner = this.clientUsers.get(input.clientId);
    if (owner !== undefined && owner !== userId) return { kind: 'rejected', reason: 'client-id-taken' };
    const last = this.lastClientSeq.get(input.clientId) ?? 0;
    if (input.clientSeq <= last) return { kind: 'duplicate' };
    const check = checkBatch(this.store, input.ops, input.blobs, { userId });
    if (!check.ok) return { kind: 'rejected', reason: check.reason, missingBlobs: check.missingBlobs };
    const added = estimateBatchChars(check.ops, check.blobs);
    if (this.sizeChars < 0) this.sizeChars = estimateStoreChars(this.store);
    if (added > ALWAYS_ACCEPTED_BATCH_CHARS && this.sizeChars + added > MAX_ROOM_CHARS) return { kind: 'rejected', reason: 'room-too-large' };
    this.sizeChars += added;
    for (const [id, json] of Object.entries(check.blobs)) this.store.putBlob(id, json);
    this.recordAuthors(check.ops, { clientId: input.clientId, userId, at: now });
    applyOps(this.store, check.ops);
    this.forgetDeletedItineraries(check.ops);
    this.rememberClientSeq(input.clientId, input.clientSeq, userId);
    this.sequence += 1;
    return {
      kind: 'applied',
      batch: {
        seq: this.sequence,
        clientId: input.clientId,
        clientSeq: input.clientSeq,
        userId,
        ops: check.ops,
        blobs: check.blobs,
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
    this.forgetDeletedItineraries(batch.ops);
    this.rememberClientSeq(batch.clientId, Math.max(batch.clientSeq, this.lastClientSeqOf(batch.clientId)), batch.userId);
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
  private rememberClientSeq(clientId: string, clientSeq: number, userId: string): void {
    this.lastClientSeq.delete(clientId);
    this.lastClientSeq.set(clientId, clientSeq);
    if (!this.clientUsers.has(clientId)) this.clientUsers.set(clientId, userId);
    while (this.lastClientSeq.size > MAX_REMEMBERED_CLIENTS) {
      const oldest = this.lastClientSeq.keys().next().value!;
      this.lastClientSeq.delete(oldest);
      this.clientUsers.delete(oldest);
    }
  }

  /** Auteurs des itinéraires supprimés oubliés (la table ne grandit pas avec une longue session). */
  private forgetDeletedItineraries(ops: readonly Op[]): void {
    for (const op of ops) {
      if (op.t !== 'd') continue;
      const itineraryId = itineraryIdOf(op.id);
      if (itineraryId && !this.store.has(itineraryObjectId(itineraryId))) this.authors.delete(itineraryId);
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
