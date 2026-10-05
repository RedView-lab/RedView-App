import type { DerivedKind } from '@/features/itineraryPanel/context/ProjectStore/collab';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { comparePositions, ObjectStore, type DocObject } from './model/objects';
import type { Op } from './model/ops';

/**
 * Protocole client ↔ serveur temps réel (WebSocket, messages JSON, compressés
 * par permessage-deflate). Versionné : un client d'une autre version est
 * refusé (`error: version`) et recharge l'application.
 *
 * Déroulé (comme Figma) :
 *  1. `hello` (jeton, dernière séquence connue) → `welcome` avec l'état
 *     complet, ou seulement les lots manquants si le client se reconnecte à la
 *     même instance de salle (`epoch`) ;
 *  2. le client envoie ses modifications par lots numérotés (`clientSeq`) ;
 *     le serveur les applique dans son ordre, leur donne la séquence suivante
 *     et les diffuse à tous — pour l'émetteur, c'est l'acquittement ;
 *  3. `durable` : les lots jusqu'à cette séquence sont dans le journal. Un
 *     client garde ses lots acquittés mais pas encore durables : si le serveur
 *     s'arrête avant de les écrire, il les renvoie à la reconnexion
 *     (`welcome.clientSeq` dit lesquels le serveur a déjà).
 */
export const PROTOCOL_VERSION = 1;

/** Lot numéroté par le serveur (diffusé à tous ; pour son émetteur, c'est l'acquittement). */
export interface SequencedBatch {
  seq: number;
  clientId: string;
  clientSeq: number;
  userId: string;
  ops: Op[];
  /** Segments de tracé introduits par ce lot (id → JSON). */
  blobs: Record<string, string>;
}

/** Objet sérialisé : [id, parent, champ, position, propriétés]. */
type SerializedObject = [string, string | null, string | null, string | null, Array<[string, unknown]>];

export interface Snapshot {
  seq: number;
  objects: SerializedObject[];
  blobs: Record<string, string>;
}

/** Présence d'un éditeur (éphémère, jamais journalisée). */
export interface PresenceState {
  name?: string;
  color?: string;
  activeItineraryId?: string | null;
  activeMode?: string | null;
}

export interface PeerInfo {
  clientId: string;
  userId: string;
  presence: PresenceState;
}

export interface LeaseInfo {
  kind: DerivedKind;
  itineraryId: string;
  clientId: string;
  userId: string;
  expiresAt: number;
}

export type ClientMessage =
  | {
      type: 'hello';
      v: number;
      projectId: string;
      /** JWT Appwrite de l'utilisateur. */
      token: string;
      clientId: string;
      /** Instance de salle et dernière séquence connues (reconnexion) : le serveur n'envoie que la suite. */
      epoch: string | null;
      lastSeq: number | null;
      presence?: PresenceState;
      /** Développement seulement (projets locaux du compte démo) : document qui crée la salle. */
      seed?: ProjectDocument;
    }
  | { type: 'batch'; clientSeq: number; ops: Op[]; blobs: Record<string, string> }
  | { type: 'lease'; action: 'request' | 'renew' | 'release'; kind: DerivedKind; itineraryId: string }
  | { type: 'presence'; presence: PresenceState }
  | { type: 'ping'; t: number };

export type ServerErrorCode = 'unauthorized' | 'forbidden' | 'not-found' | 'version' | 'busy' | 'bad-request' | 'internal';

export type ServerMessage =
  | {
      type: 'welcome';
      v: number;
      /** Instance de la salle (change à chaque chargement : les séquences d'avant un arrêt ne se comparent pas). */
      epoch: string;
      clientId: string;
      userId: string;
      seq: number;
      durableSeq: number;
      /** Dernier lot de ce client appliqué par le serveur : les suivants sont à renvoyer. */
      clientSeq: number;
      /** État complet (première connexion, ou retard trop grand). */
      snapshot?: Snapshot;
      /** Lots manquants depuis `lastSeq` (reconnexion). */
      catchUp?: SequencedBatch[];
      peers: PeerInfo[];
      leases: LeaseInfo[];
    }
  | { type: 'batch'; batch: SequencedBatch }
  | { type: 'durable'; seq: number }
  | { type: 'duplicate'; clientSeq: number }
  | { type: 'reject'; clientSeq: number; reason: string; missingBlobs?: string[] }
  | { type: 'leases'; leases: LeaseInfo[] }
  | { type: 'lease-denied'; kind: DerivedKind; itineraryId: string; retryAfterMs: number }
  | { type: 'peers'; peers: PeerInfo[] }
  | { type: 'error'; code: ServerErrorCode; message?: string }
  | { type: 'pong'; t: number };

export function serializeStore(store: ObjectStore, seq: number): Snapshot {
  const objects: SerializedObject[] = [];
  for (const object of store.values()) {
    objects.push([object.id, object.parent, object.field, object.pos, [...object.props]]);
  }
  const blobs: Record<string, string> = {};
  for (const id of store.blobIds()) blobs[id] = store.getBlob(id)!;
  return { seq, objects, blobs };
}

/** Magasin d'objets d'un état complet (les enfants sont reconstitués et triés). */
export function deserializeStore(snapshot: Snapshot): ObjectStore {
  const objects = new Map<string, DocObject>();
  const childIds = new Map<string, Map<string, string[]>>();
  for (const [id, parent, field, pos, props] of snapshot.objects) {
    objects.set(id, { id, parent, field, pos, props: new Map(props), children: new Map() });
    if (parent !== null && field !== null) {
      let byField = childIds.get(parent);
      if (!byField) {
        byField = new Map();
        childIds.set(parent, byField);
      }
      const list = byField.get(field) ?? [];
      list.push(id);
      byField.set(field, list);
    }
  }
  for (const [parent, byField] of childIds) {
    const object = objects.get(parent);
    if (!object) continue;
    const children = new Map<string, readonly string[]>();
    for (const [field, ids] of byField) {
      children.set(field, ids.map((id) => objects.get(id)!).sort(comparePositions).map((child) => child.id));
    }
    objects.set(parent, { ...object, children });
  }
  return new ObjectStore(objects, new Map(Object.entries(snapshot.blobs)));
}
