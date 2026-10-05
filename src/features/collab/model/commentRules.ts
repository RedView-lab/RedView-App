import {
  MAX_COMMENT_MENTIONS,
  MAX_COMMENT_TEXT_CHARS,
  MAX_COMMENT_ZONE_VERTICES,
  MIN_COMMENT_ZONE_VERTICES,
} from '@/features/comments/lib/limits';

import { isPlainRecord } from './diff';
import type { ObjectStore } from './objects';
import type { Op } from './ops';
import { decodePath, ROOT_OBJECT_ID } from './paths';

/**
 * Règles d'auteur des commentaires (features/comments), vérifiées par le
 * serveur sur chaque opération d'un lot avant de l'appliquer (validate.ts),
 * comme chez Figma :
 *  - un fil ou un message est créé au nom de l'auteur du lot ;
 *  - seul le créateur d'un fil le déplace (ancre, zone, point de vue) ou le
 *    supprime ;
 *  - seul l'auteur d'un message le modifie ou le supprime ;
 *  - chacun ne pose ou ne retire que ses propres réactions ;
 *  - tout le monde peut résoudre un fil (au nom de l'auteur du lot).
 * Une opération sur un fil ou un message absent (supprimé entre-temps par un
 * autre éditeur) est sans effet : elle passe. Le rejeu du journal ne repasse
 * pas par ici (déjà validé par le serveur qui l'a écrit).
 */

const COMMENTS_FIELD = 'comments';
const MESSAGES_FIELD = 'messages';
const REACTIONS_FIELD = 'reactions';
const THREAD_PREFIX = `${ROOT_OBJECT_ID}/${COMMENTS_FIELD}:`;
const MESSAGE_SEGMENT = `${MESSAGES_FIELD}:`;

/** Propriétés d'un fil que seul son créateur écrit. */
const THREAD_CREATOR_KEYS: ReadonlySet<string> = new Set(['anchor', 'zone', 'camera', 'createdBy', 'createdAt']);
/** Propriétés d'un message que seul son auteur écrit. */
const MESSAGE_AUTHOR_KEYS: ReadonlySet<string> = new Set(['text', 'editedAt', 'mentions', 'authorId', 'authorName', 'createdAt']);

type CommentObjectKind = 'thread' | 'message';

/** Fil (`p/comments:<id>`) ou message (`p/comments:<id>/messages:<id>`), sinon null. */
export function commentObjectKind(id: string): CommentObjectKind | null {
  if (!id.startsWith(THREAD_PREFIX)) return null;
  const rest = id.slice(THREAD_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return rest.length > 0 ? 'thread' : null;
  const tail = rest.slice(slash + 1);
  return tail.startsWith(MESSAGE_SEGMENT) && !tail.includes('/') ? 'message' : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidAnchor(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const { lng, lat, elevationM } = value;
  return isFiniteNumber(lng) && Math.abs(lng) <= 180
    && isFiniteNumber(lat) && Math.abs(lat) <= 90
    && (elevationM === null || isFiniteNumber(elevationM));
}

function isValidZone(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainRecord(value) || !Array.isArray(value.ring)) return false;
  const { ring } = value;
  if (ring.length < MIN_COMMENT_ZONE_VERTICES || ring.length > MAX_COMMENT_ZONE_VERTICES) return false;
  return ring.every((vertex) => Array.isArray(vertex)
    && vertex.length === 2
    && isFiniteNumber(vertex[0]) && Math.abs(vertex[0]) <= 180
    && isFiniteNumber(vertex[1]) && Math.abs(vertex[1]) <= 90);
}

function isValidCamera(value: unknown): boolean {
  return isPlainRecord(value) && isFiniteNumber(value.zoom) && isFiniteNumber(value.pitch) && isFiniteNumber(value.bearing);
}

function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function isEmptyRecord(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

/** Une écriture `key = value` (`present` : posée, sinon retirée) sur un fil. */
function checkThreadWrite(creatorId: unknown, key: string, present: boolean, value: unknown, userId: string): string | null {
  if (THREAD_CREATOR_KEYS.has(key) && creatorId !== userId) return 'comment-not-creator';
  if (!present) return null;
  switch (key) {
    case 'anchor':
      return isValidAnchor(value) ? null : 'comment-bad-anchor';
    case 'zone':
      return isValidZone(value) ? null : 'comment-bad-zone';
    case 'camera':
      return isValidCamera(value) ? null : 'comment-bad-camera';
    case 'createdBy':
      return value === userId ? null : 'comment-not-creator';
    case 'resolvedBy':
      return value === userId ? null : 'comment-not-resolver';
    case MESSAGES_FIELD:
      // Liste de messages : un objet par message, jamais une valeur atomique.
      return isEmptyList(value) ? null : 'comment-bad-messages';
    default:
      return null;
  }
}

/** Une écriture sur un message (`key` : chemin encodé de la propriété). */
function checkMessageWrite(authorId: unknown, key: string, present: boolean, value: unknown, userId: string): string | null {
  const [field, reactionKey, ...extra] = decodePath(key);
  if (field === REACTIONS_FIELD) {
    if (reactionKey === undefined) {
      // Réglage vidé : `{}` ou retiré (les clés retirées une à une, chacune vérifiée).
      return !present || isEmptyRecord(value) ? null : 'comment-bad-reactions';
    }
    if (extra.length > 0 || !reactionKey.endsWith(`~${userId}`)) return 'comment-not-reactor';
    return !present || value === true ? null : 'comment-bad-reactions';
  }
  if (MESSAGE_AUTHOR_KEYS.has(key) && authorId !== userId) return 'comment-not-author';
  if (!present) return key === 'text' || key === 'authorId' ? 'comment-bad-message' : null;
  switch (key) {
    case 'authorId':
      return value === userId ? null : 'comment-not-author';
    case 'text':
      return typeof value === 'string' && value.length <= MAX_COMMENT_TEXT_CHARS ? null : 'comment-bad-text';
    case 'mentions':
      return Array.isArray(value) && value.length <= MAX_COMMENT_MENTIONS && value.every((id) => typeof id === 'string')
        ? null
        : 'comment-bad-mentions';
    default:
      return null;
  }
}

function checkWrite(kind: CommentObjectKind, owner: unknown, key: string, present: boolean, value: unknown, userId: string): string | null {
  return kind === 'thread'
    ? checkThreadWrite(owner, key, present, value, userId)
    : checkMessageWrite(owner, key, present, value, userId);
}

const ownerKey = (kind: CommentObjectKind) => (kind === 'thread' ? 'createdBy' : 'authorId');

/**
 * Raison du refus de `op` par `userId`, ou null : l'opération respecte les
 * règles des commentaires (ou ne les concerne pas). `store` : état avant `op`
 * (les opérations précédentes du lot appliquées).
 */
export function checkCommentOp(store: ObjectStore, op: Op, userId: string): string | null {
  if (op.id === ROOT_OBJECT_ID) {
    // Fils de la racine : une liste d'objets, jamais une valeur atomique.
    if (op.t === 's' && decodePath(op.k)[0] === COMMENTS_FIELD && 'v' in op && !isEmptyList(op.v)) {
      return 'comment-bad-list';
    }
    return null;
  }
  const kind = commentObjectKind(op.id);
  if (!kind) return null;
  const existing = store.get(op.id);
  const owner = existing?.props.get(ownerKey(kind));
  switch (op.t) {
    case 'c': {
      if (!existing) {
        // Nouveau fil ou message : au nom de l'auteur du lot, contenu valable.
        if (!store.has(op.parent)) return null;
        const props = new Map(op.props);
        if (props.get(ownerKey(kind)) !== userId) return kind === 'thread' ? 'comment-not-creator' : 'comment-not-author';
        if (kind === 'thread' && !isValidAnchor(props.get('anchor'))) return 'comment-bad-anchor';
        if (kind === 'message' && typeof props.get('text') !== 'string') return 'comment-bad-message';
        for (const [key, value] of op.props) {
          const denied = checkWrite(kind, userId, key, true, value, userId);
          if (denied) return denied;
        }
        return null;
      }
      // Même objet créé deux fois : ses propriétés sont des écritures.
      for (const [key, value] of op.props) {
        const denied = checkWrite(kind, owner, key, true, value, userId);
        if (denied) return denied;
      }
      return null;
    }
    case 's':
      if (!existing) return null;
      return checkWrite(kind, owner, op.k, 'v' in op, 'v' in op ? op.v : undefined, userId);
    case 'd':
      if (!existing || owner === userId) return null;
      return kind === 'thread' ? 'comment-not-creator' : 'comment-not-author';
    case 'm':
      return null;
  }
}
