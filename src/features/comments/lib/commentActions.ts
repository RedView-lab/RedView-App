import type {
  ProjectCommentAnchor,
  ProjectCommentCamera,
  ProjectCommentMessage,
  ProjectCommentThread,
  ProjectCommentZone,
} from '@/features/itineraryPanel/types';

import { MAX_COMMENT_MENTIONS, MAX_COMMENT_TEXT_CHARS } from './limits';

/**
 * Toutes les écritures des commentaires, en fonctions pures : l'interface de
 * l'app et le viewer LiDAR (par son pont) passent par le même réducteur, puis
 * par `commitComments` du ProjectStore. Mêmes droits que ceux vérifiés par le
 * serveur (collab/model/commentRules.ts), comme chez Figma :
 *  - chacun modifie ou supprime ses propres messages ;
 *  - seul le créateur d'un fil le déplace ou le supprime (supprimer son
 *    premier message supprime le fil) ;
 *  - tout le monde répond, réagit (pour soi) et résout.
 * Les ids et les dates viennent de l'appelant : le réducteur reste pur (et
 * une action rejouée donne le même résultat).
 */

export interface CommentAuthor {
  userId: string;
  name: string;
}

export interface CommentTextInput {
  text: string;
  mentions?: readonly string[];
}

export type CommentAction =
  | (CommentTextInput & {
      type: 'create-thread';
      threadId: string;
      messageId: string;
      anchor: ProjectCommentAnchor;
      zone?: ProjectCommentZone;
      camera?: ProjectCommentCamera;
      at: string;
    })
  | (CommentTextInput & { type: 'reply'; threadId: string; messageId: string; at: string })
  | (CommentTextInput & { type: 'edit-message'; threadId: string; messageId: string; at: string })
  | { type: 'delete-message'; threadId: string; messageId: string }
  | { type: 'delete-thread'; threadId: string }
  | { type: 'set-resolved'; threadId: string; resolved: boolean; at: string }
  | { type: 'toggle-reaction'; threadId: string; messageId: string; emoji: string }
  | { type: 'move-thread'; threadId: string; anchor: ProjectCommentAnchor };

/** Réactions proposées (comme le sélecteur rapide de Figma). */
export const COMMENT_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🔥', '⚠️'] as const;

const REACTION_SEPARATOR = '~';

export function reactionKey(emoji: string, userId: string): string {
  return `${emoji}${REACTION_SEPARATOR}${userId}`;
}

/** Réactions d'un message regroupées par emoji (ordre de première apparition). */
export function groupReactions(message: ProjectCommentMessage): Array<{ emoji: string; userIds: string[] }> {
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(message.reactions ?? {})) {
    const separator = key.lastIndexOf(REACTION_SEPARATOR);
    if (separator <= 0) continue;
    const emoji = key.slice(0, separator);
    const userId = key.slice(separator + 1);
    const users = groups.get(emoji) ?? [];
    users.push(userId);
    groups.set(emoji, users);
  }
  return [...groups].map(([emoji, userIds]) => ({ emoji, userIds }));
}

export function canEditMessage(message: Pick<ProjectCommentMessage, 'authorId'>, me: Pick<CommentAuthor, 'userId'>): boolean {
  return message.authorId === me.userId;
}

/** Déplacer ou supprimer le fil : son créateur. */
export function canManageThread(thread: Pick<ProjectCommentThread, 'createdBy'>, me: Pick<CommentAuthor, 'userId'>): boolean {
  return thread.createdBy === me.userId;
}

/** Texte saisi, prêt à enregistrer (null : vide ou trop long). */
export function normalizeCommentText(text: string): string | null {
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (trimmed.length === 0 || trimmed.length > MAX_COMMENT_TEXT_CHARS) return null;
  return trimmed;
}

function normalizeMentions(mentions: readonly string[] | undefined, authorId: string): string[] | undefined {
  if (!mentions) return undefined;
  const unique = [...new Set(mentions.filter((id) => typeof id === 'string' && id.length > 0 && id !== authorId))];
  return unique.length > 0 ? unique.slice(0, MAX_COMMENT_MENTIONS) : undefined;
}

function buildMessage(id: string, me: CommentAuthor, text: string, mentions: string[] | undefined, at: string): ProjectCommentMessage {
  const message: ProjectCommentMessage = { id, authorId: me.userId, authorName: me.name, text, createdAt: at };
  if (mentions) message.mentions = mentions;
  return message;
}

function replaceThread(
  threads: readonly ProjectCommentThread[],
  threadId: string,
  update: (thread: ProjectCommentThread) => ProjectCommentThread | null,
): readonly ProjectCommentThread[] | null {
  const index = threads.findIndex((thread) => thread.id === threadId);
  if (index < 0) return null;
  const next = update(threads[index]);
  if (!next || next === threads[index]) return null;
  const out = [...threads];
  out[index] = next;
  return out;
}

function replaceMessage(
  thread: ProjectCommentThread,
  messageId: string,
  update: (message: ProjectCommentMessage) => ProjectCommentMessage | null,
): ProjectCommentThread | null {
  const index = thread.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  const next = update(thread.messages[index]);
  if (!next || next === thread.messages[index]) return null;
  const messages = [...thread.messages];
  messages[index] = next;
  return { ...thread, messages };
}

function withoutResolution(thread: ProjectCommentThread): ProjectCommentThread {
  if (thread.resolvedAt === undefined && thread.resolvedBy === undefined) return thread;
  const next = { ...thread };
  delete next.resolvedAt;
  delete next.resolvedBy;
  return next;
}

/**
 * Fils après `action` de `me`, ou null : action refusée (droits, texte vide,
 * fil ou message introuvable) ou sans effet.
 */
export function applyCommentAction(
  threads: readonly ProjectCommentThread[],
  action: CommentAction,
  me: CommentAuthor,
): readonly ProjectCommentThread[] | null {
  switch (action.type) {
    case 'create-thread': {
      const text = normalizeCommentText(action.text);
      if (!text || threads.some((thread) => thread.id === action.threadId)) return null;
      const thread: ProjectCommentThread = {
        id: action.threadId,
        anchor: action.anchor,
        createdBy: me.userId,
        createdAt: action.at,
        messages: [buildMessage(action.messageId, me, text, normalizeMentions(action.mentions, me.userId), action.at)],
      };
      if (action.zone) thread.zone = action.zone;
      if (action.camera) thread.camera = action.camera;
      return [...threads, thread];
    }
    case 'reply': {
      const text = normalizeCommentText(action.text);
      if (!text) return null;
      return replaceThread(threads, action.threadId, (thread) => {
        if (thread.messages.some((message) => message.id === action.messageId)) return null;
        // Répondre rouvre un fil résolu.
        const open = withoutResolution(thread);
        const message = buildMessage(action.messageId, me, text, normalizeMentions(action.mentions, me.userId), action.at);
        return { ...open, messages: [...open.messages, message] };
      });
    }
    case 'edit-message': {
      const text = normalizeCommentText(action.text);
      if (!text) return null;
      return replaceThread(threads, action.threadId, (thread) => replaceMessage(thread, action.messageId, (message) => {
        if (!canEditMessage(message, me)) return null;
        const mentions = normalizeMentions(action.mentions, me.userId);
        if (message.text === text && (message.mentions ?? []).join() === (mentions ?? []).join()) return null;
        const next: ProjectCommentMessage = { ...message, text, editedAt: action.at };
        if (mentions) next.mentions = mentions;
        else delete next.mentions;
        return next;
      }));
    }
    case 'delete-message': {
      const thread = threads.find((candidate) => candidate.id === action.threadId);
      if (!thread) return null;
      const index = thread.messages.findIndex((message) => message.id === action.messageId);
      if (index < 0 || !canEditMessage(thread.messages[index], me)) return null;
      // Le premier message porte le fil : le supprimer supprime le fil.
      if (index === 0) {
        return canManageThread(thread, me) ? threads.filter((candidate) => candidate.id !== thread.id) : null;
      }
      return replaceThread(threads, thread.id, (current) => ({
        ...current,
        messages: current.messages.filter((message) => message.id !== action.messageId),
      }));
    }
    case 'delete-thread': {
      const thread = threads.find((candidate) => candidate.id === action.threadId);
      if (!thread || !canManageThread(thread, me)) return null;
      return threads.filter((candidate) => candidate.id !== thread.id);
    }
    case 'set-resolved':
      return replaceThread(threads, action.threadId, (thread) => {
        if (!action.resolved) return withoutResolution(thread);
        if (thread.resolvedAt !== undefined) return null;
        return { ...thread, resolvedAt: action.at, resolvedBy: me.userId };
      });
    case 'toggle-reaction': {
      if (action.emoji.length === 0 || action.emoji.length > 16 || action.emoji.includes(REACTION_SEPARATOR)) return null;
      return replaceThread(threads, action.threadId, (thread) => replaceMessage(thread, action.messageId, (message) => {
        const key = reactionKey(action.emoji, me.userId);
        const reactions = { ...(message.reactions ?? {}) };
        if (reactions[key]) delete reactions[key];
        else reactions[key] = true;
        const next = { ...message };
        if (Object.keys(reactions).length > 0) next.reactions = reactions;
        else delete next.reactions;
        return next;
      }));
    }
    case 'move-thread':
      return replaceThread(threads, action.threadId, (thread) => {
        if (!canManageThread(thread, me)) return null;
        const { anchor } = action;
        if (anchor.lng === thread.anchor.lng && anchor.lat === thread.anchor.lat) return null;
        const next: ProjectCommentThread = { ...thread, anchor };
        // La zone suit sa bulle.
        if (thread.zone) {
          const dLng = anchor.lng - thread.anchor.lng;
          const dLat = anchor.lat - thread.anchor.lat;
          next.zone = { ring: thread.zone.ring.map(([lng, lat]) => [lng + dLng, lat + dLat] as [number, number]) };
        }
        return next;
      });
  }
}

/** Fil d'après son id. */
export function findThread(threads: readonly ProjectCommentThread[] | undefined, threadId: string | null): ProjectCommentThread | null {
  if (!threadId || !threads) return null;
  return threads.find((thread) => thread.id === threadId) ?? null;
}
