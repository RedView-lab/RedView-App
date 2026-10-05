import { createContext, useContext, type MutableRefObject } from 'react';

import type {
  Itinerary,
  ProjectCommentAnchor,
  ProjectCommentsView,
  ProjectCommentThread,
  ProjectCommentZone,
} from '@/features/itineraryPanel/types';

import type { CommentAction, CommentAuthor, CommentTextInput } from '../lib/commentActions';
import type { MentionCandidate } from '../lib/messageText';

/** Contexte de l'outil Commentaire (fournisseur : CommentToolContext.tsx). */

export type CommentSubTool = 'point' | 'zone';

export interface CommentDraft {
  anchor: ProjectCommentAnchor;
  zone?: ProjectCommentZone;
}

export type ThreadAction<T extends CommentAction['type']> = Omit<Extract<CommentAction, { type: T }>, 'type' | 'at' | 'messageId'>;

export interface CommentToolValue {
  me: CommentAuthor;
  threads: readonly ProjectCommentThread[];
  view: ProjectCommentsView | undefined;
  /** Membres du projet (mentions, noms à jour). */
  members: readonly MentionCandidate[];
  nameOf(userId: string, fallback?: string): string;
  /** Itinéraire actif (km d'une bulle sur son tracé). */
  activeItinerary: Itinerary | null;

  armed: boolean;
  subTool: CommentSubTool;
  arm(subTool?: CommentSubTool): void;
  toggle(): void;
  deactivate(): void;
  statusMessage: string | null;

  openThreadId: string | null;
  openThread(threadId: string, options?: { fly?: boolean }): void;
  closeThread(): void;
  hoveredThreadId: string | null;
  setHoveredThreadId(threadId: string | null): void;

  draft: CommentDraft | null;
  startDraft(draft: CommentDraft): void;
  cancelDraft(): void;
  submitDraft(input: CommentTextInput): boolean;
  /** Texte en cours de la saisie (tenu par le composant de saisie). */
  draftTextRef: MutableRefObject<string>;
  /** Incrémenté pour redonner le focus à la saisie (clic ailleurs avec un texte en cours). */
  draftFocusRequest: number;
  /** Zone en cours de tracé (Maj + glisser). */
  dragZone: ProjectCommentZone | null;

  reply(threadId: string, input: CommentTextInput): boolean;
  editMessage(threadId: string, messageId: string, input: CommentTextInput): boolean;
  deleteMessage(threadId: string, messageId: string): boolean;
  deleteThread(threadId: string): boolean;
  setResolved(threadId: string, resolved: boolean): boolean;
  toggleReaction(threadId: string, messageId: string, emoji: string): boolean;
  moveThread(action: ThreadAction<'move-thread'>): boolean;

  markUnread(threadId: string): void;
  setViewOptions(patch: Partial<Omit<ProjectCommentsView, 'reads'>>): void;
  pinsHidden: boolean;
  togglePinsHidden(): void;
  unreadCount: number;

  flyToThread(thread: ProjectCommentThread): void;
  /** Lecture seule (viewer LiDAR sans l'app ouverte) : ni réponse, ni réaction, ni modification. */
  readOnly?: boolean;
  /** Fil suivant / précédent (ordre de la liste) : ouvert, caméra amenée dessus. */
  navigate(direction: 1 | -1): void;
}

export const CommentToolContext = createContext<CommentToolValue | null>(null);

export function useCommentToolOptional(): CommentToolValue | null {
  return useContext(CommentToolContext);
}
