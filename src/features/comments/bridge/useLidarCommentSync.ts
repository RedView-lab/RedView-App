import { useEffect, useRef } from 'react';

import type { ProjectCommentsView, ProjectCommentThread } from '@/features/itineraryPanel/types';

import type { CommentAction, CommentAuthor } from '../lib/commentActions';
import type { CommentMembersStatus } from '../lib/authorName';
import type { MentionCandidate } from '../lib/messageText';
import {
  answersLidarHello,
  postLidarCommentMessage,
  clearStoredLidarCommentState,
  publishLidarCommentState,
  subscribeLidarComments,
  type LidarCommentState,
} from './lidarCommentChannel';

/**
 * Côté app : publie les commentaires du projet ouvert pour le viewer LiDAR et
 * applique ses actions (même réducteur, puis la session temps réel). Rien
 * n'est publié sans projet ; fermer le projet le dit au viewer.
 */

interface UseLidarCommentSyncArgs {
  projectId: string | null;
  me: CommentAuthor;
  members: readonly MentionCandidate[];
  membersStatus?: CommentMembersStatus;
  threads: readonly ProjectCommentThread[];
  reads: ProjectCommentsView['reads'];
  onAction(action: CommentAction): void;
  onMarkRead(threadId: string): void;
  onMarkUnread(threadId: string): void;
}

export function useLidarCommentSync({ projectId, me, members, membersStatus, threads, reads, onAction, onMarkRead, onMarkUnread }: UseLidarCommentSyncArgs): void {
  const stateRef = useRef<LidarCommentState | null>(null);
  const handlers = useRef({ onAction, onMarkRead, onMarkUnread });
  useEffect(() => {
    handlers.current = { onAction, onMarkRead, onMarkUnread };
  });

  useEffect(() => {
    if (!projectId) {
      stateRef.current = null;
      return;
    }
    const state: LidarCommentState = {
      version: 1,
      type: 'STATE',
      projectId,
      updatedAt: new Date().toISOString(),
      me,
      members: [...members],
      ...(membersStatus ? { membersStatus } : {}),
      threads: [...threads],
      reads: reads ?? {},
    };
    stateRef.current = state;
    // Tout de suite, sans minuterie : pendant qu'on travaille dans le viewer,
    // l'onglet de l'app est en arrière-plan et ses minuteries sont freinées
    // (jusqu'à une par minute après 5 min) — le viewer attendrait sa réponse.
    publishLidarCommentState(state);
  }, [me, members, membersStatus, projectId, reads, threads]);

  // Projet fermé (ou autre projet ouvert) : le viewer passe en lecture seule.
  useEffect(() => {
    if (!projectId) return;
    return () => {
      postLidarCommentMessage({ version: 1, type: 'CLOSED', projectId });
      clearStoredLidarCommentState(projectId);
    };
  }, [projectId]);

  useEffect(() => subscribeLidarComments((message) => {
    const state = stateRef.current;
    if (!state) return;
    if (message.type === 'HELLO') {
      if (!answersLidarHello(message, state.projectId)) return;
      publishLidarCommentState({ ...state, updatedAt: new Date().toISOString() });
      return;
    }
    if (message.type === 'COMMENT_ACTION' && message.projectId === state.projectId) {
      handlers.current.onAction(message.action);
      return;
    }
    if (message.type === 'MARK_READ' && message.projectId === state.projectId) {
      handlers.current.onMarkRead(message.threadId);
      return;
    }
    if (message.type === 'MARK_UNREAD' && message.projectId === state.projectId) {
      handlers.current.onMarkUnread(message.threadId);
    }
  }), []);
}
