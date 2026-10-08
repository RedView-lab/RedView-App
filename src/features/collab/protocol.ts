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
 *  0. ouverture de la WebSocket : le JWT Appwrite voyage dans
 *     `Sec-WebSocket-Protocol` (`redview.v<version>`, `auth.<jwt en
 *     base64url>`) et le projet dans l'URL (`?project=`) — le serveur vérifie
 *     jeton, droits, origine et plafonds AVANT d'accepter la connexion (refus :
 *     fermée aussitôt avec son code), aucun message d'un inconnu n'est lu ;
 *  1. `hello` (client, dernière séquence connue) → `welcome` avec l'état
 *     complet, ou seulement les lots manquants si le client se reconnecte à la
 *     même instance de salle (`epoch`) ;
 *  2. le client envoie ses modifications par lots numérotés (`clientSeq`) ;
 *     le serveur les applique dans son ordre, leur donne la séquence suivante
 *     et les diffuse à tous — pour l'émetteur, c'est l'acquittement ;
 *  3. `durable` : les lots jusqu'à cette séquence sont dans le journal. Un
 *     client garde ses lots acquittés mais pas encore durables : si le serveur
 *     s'arrête avant de les écrire, il les renvoie à la reconnexion
 *     (`welcome.clientSeq` dit lesquels le serveur a déjà) ;
 *  4. `auth` : le client présente un JWT frais toutes les quelques minutes ;
 *     une connexion dont le jeton a expiré sans relève est fermée (4401) — une
 *     session déconnectée ou un jeton volé ne la garde pas ouverte.
 */
/**
 * 2 : fils de commentaires dans le document (`p/comments:*`, schema.ts) ; un
 * client de la version 1 les réécrirait en valeur atomique.
 * 3 : canal `motion` (caméra, curseur, survol du graphique) et présence
 * `following` / `spotlight` : tous les éditeurs d'une salle se suivent et se
 * voient (livePresence).
 * 4 : jeton et projet présentés à l'ouverture de la WebSocket (plus dans
 * `hello`), relève du jeton (`auth`).
 */
export const PROTOCOL_VERSION = 4;

/**
 * Versions dont les lots ont le format actuel : la copie des lots non écrits
 * laissée sur l'appareil par l'une d'elles est reprise (client/unsyncedStore).
 * La 3 n'a ajouté que des messages éphémères, la 4 n'a changé que l'ouverture.
 */
export const BATCH_FORMAT_PROTOCOLS: readonly number[] = [2, 3, 4];

/** Sous-protocole WebSocket de cette version (le serveur ne retient que lui). */
export const SOCKET_PROTOCOL = `redview.v${PROTOCOL_VERSION}`;
const AUTH_PROTOCOL_PREFIX = 'auth.';

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Sous-protocoles présentés à l'ouverture : la version, puis le jeton (base64url : un sous-protocole est un « token » HTTP). */
export function socketProtocols(token: string): string[] {
  return [SOCKET_PROTOCOL, `${AUTH_PROTOCOL_PREFIX}${toBase64Url(token)}`];
}

/** Jeton d'une liste de sous-protocoles (en-tête `Sec-WebSocket-Protocol`), null s'il manque ou est illisible. */
export function tokenFromProtocols(protocols: Iterable<string>): string | null {
  for (const protocol of protocols) {
    if (protocol.startsWith(AUTH_PROTOCOL_PREFIX)) return fromBase64Url(protocol.slice(AUTH_PROTOCOL_PREFIX.length));
  }
  return null;
}

/** URL de la WebSocket d'un projet (`wss://…/multiplayer?project=<id>`). */
export function projectSocketUrl(url: string, projectId: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectId)}`;
}

/**
 * Lot numéroté par le serveur (diffusé à tous ; pour son émetteur, c'est
 * l'acquittement — sans `blobs` s'il l'a demandé, `hello.leanEcho`).
 */
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

/** Présence d'un éditeur (éphémère, jamais journalisée), diffusée regroupée à ≈ 10 Hz. */
export interface PresenceState {
  name?: string;
  color?: string;
  activeItineraryId?: string | null;
  activeMode?: string | null;
  /** Éditeur suivi (`clientId`), comme le mode observation de Figma. */
  following?: string | null;
  /**
   * Présente sa vue (Spotlight) : numéro d'ordre donné par la salle (instant
   * en ms, strictement croissant), le plus grand l'emporte — le même pour
   * tous, et jamais réutilisé après un redémarrage du serveur.
   */
  spotlight?: number | null;
}

/**
 * Présence envoyée par un client : il demande le Spotlight (`true`), la salle
 * le numérote ; à la reconnexion, il redonne son numéro (gardé : une
 * présentation qui continue n'est pas reproposée à ceux qui l'ont déclinée).
 */
export type PresenceUpdate = Omit<PresenceState, 'spotlight'> & { spotlight?: boolean | number };

export interface PeerInfo {
  clientId: string;
  userId: string;
  presence: PresenceState;
}

/**
 * Canal `motion` : ce que voit et pointe un éditeur, échantillonné jusqu'à
 * 30 Hz. Éphémère et avec pertes (jamais journalisé ; sauté plutôt que mis en
 * file sous contre-pression) : chaque champ présent est l'état courant de son
 * flux, le message suivant répare une perte. Horodaté par l'émetteur
 * (`performance.now()`) : le récepteur le rejoue légèrement en différé,
 * interpolé (livePresence/lib/playout).
 */
/** Caméra Mapbox : [lng, lat, zoom, cap, inclinaison, champ vertical (°)]. */
export type MotionCamera = [number, number, number, number, number, number];
/**
 * Carte de l'émetteur, en px de mise en page : [largeur, hauteur, encarts
 * haut droite bas gauche (panneaux qui la couvrent), padding Mapbox haut
 * droite bas gauche].
 */
export type MotionViewport = [number, number, number, number, number, number, number, number, number, number];
/** Pointeur sur la carte : [lng, lat] (posé sur le relief). */
export type MotionPointer = [number, number];
/** Survol du graphique d'analyse : [itinéraire, distance depuis son départ (m)]. */
export type MotionChart = [string, number];

export interface MotionFields {
  cam?: MotionCamera;
  vp?: MotionViewport;
  /** null : pointeur hors de la carte. */
  ptr?: MotionPointer | null;
  /** null : rien de survolé. */
  chart?: MotionChart | null;
}

/** Dernier état connu d'un éditeur (champs fusionnés), donné à l'arrivée dans la salle. */
export interface MotionState extends MotionFields {
  clientId: string;
  t: number;
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
      clientId: string;
      /** Instance de salle et dernière séquence connues (reconnexion) : le serveur n'envoie que la suite. */
      epoch: string | null;
      lastSeq: number | null;
      presence?: PresenceUpdate;
      /** Développement seulement (projets locaux du compte démo) : document qui crée la salle. */
      seed?: ProjectDocument;
      /** Ce client lit les messages compressés (trame binaire, voir `wire.ts`) : le serveur compresse les gros pour lui. */
      compress?: boolean;
      /**
       * Ce client garde les segments de tracé de ses propres lots : leur
       * acquittement (le lot diffusé) lui revient sans `blobs`. Absent (ancien
       * client) : lot complet.
       */
      leanEcho?: boolean;
    }
  | { type: 'batch'; clientSeq: number; ops: Op[]; blobs: Record<string, string> }
  | { type: 'lease'; action: 'request' | 'renew' | 'release'; kind: DerivedKind; itineraryId: string }
  | { type: 'presence'; presence: PresenceUpdate }
  | ({ type: 'motion'; t: number } & MotionFields)
  | { type: 'ping'; t: number }
  /** Relève du JWT (même utilisateur) : repousse l'expiration de la connexion. */
  | { type: 'auth'; token: string };

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
      /** Dernier état `motion` des autres éditeurs (caméra de départ pour les suivre). */
      motions?: MotionState[];
      /** Le serveur lit les messages compressés : le client peut compresser ses gros envois (`wire.ts`). */
      compress?: boolean;
    }
  | { type: 'batch'; batch: SequencedBatch }
  | ({ type: 'motion'; from: string; t: number } & MotionFields)
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

/** Profondeur maximale d'un objet sous la racine (le modèle en a 4 : fil → message, itinéraire → ligne). */
const MAX_SNAPSHOT_DEPTH = 16;

/**
 * État complet relu du stockage (serveur) : structure vérifiée avant de s'en
 * servir — une racine, des ids uniques, chaque objet sous un parent présent,
 * sans cycle ni profondeur aberrante, des segments en texte. Un état mal formé
 * (fichier corrompu ou forgé) lève au lieu de figer la salle (boucle sur des
 * parents en cycle) ou de la faire planter plus tard.
 */
export function deserializeCheckedStore(snapshot: Snapshot): ObjectStore {
  const fail = (reason: string): never => {
    throw new Error(`état complet invalide : ${reason}`);
  };
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.objects)) fail('objets');
  const blobs: unknown = snapshot.blobs;
  if (blobs === null || typeof blobs !== 'object' || Array.isArray(blobs)) fail('segments');
  for (const json of Object.values(blobs as Record<string, unknown>)) if (typeof json !== 'string') fail('segment');
  const parents = new Map<string, string | null>();
  for (const entry of snapshot.objects as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 5) fail('objet');
    const [id, parent, field, pos, props] = entry as unknown[];
    if (typeof id !== 'string' || id.length === 0 || id.length > 1024 || parents.has(id)) fail('id');
    const root = parent === null;
    if (root !== (field === null) || root !== (pos === null)) fail(`objet ${String(id)}`);
    if (!root && (typeof parent !== 'string' || typeof field !== 'string' || typeof pos !== 'string')) fail(`objet ${String(id)}`);
    if (root && id !== 'p') fail('racine');
    if (!Array.isArray(props) || props.some((prop) => !Array.isArray(prop) || prop.length !== 2 || typeof prop[0] !== 'string')) {
      fail(`propriétés de ${String(id)}`);
    }
    parents.set(id as string, parent as string | null);
  }
  if (!parents.has('p')) fail('racine absente');
  const depthOf = new Map<string, number>([['p', 0]]);
  for (const id of parents.keys()) {
    const chain: string[] = [];
    let current: string | null = id;
    while (current !== null && !depthOf.has(current)) {
      chain.push(current);
      if (chain.length > MAX_SNAPSHOT_DEPTH) fail(`profondeur ou cycle sous ${id}`);
      const parent: string | null | undefined = parents.get(current);
      if (parent === undefined) fail(`parent absent de ${current}`);
      current = parent as string | null;
    }
    let depth = current === null ? 0 : depthOf.get(current)!;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      depth += 1;
      if (depth > MAX_SNAPSHOT_DEPTH) fail(`profondeur sous ${id}`);
      depthOf.set(chain[index], depth);
    }
  }
  return deserializeStore(snapshot);
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
