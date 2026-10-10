// ============================================
// Viewer LiDAR — couche React des commentaires (bulles, fil ouvert, nouveau commentaire)
// ============================================

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { CommentDraftPin, CommentPin } from '@/features/comments/components/CommentPin';
import { CommentDraftCard, CommentThreadCard } from '@/features/comments/components/CommentThreadCard';
import type { CommentToolValue } from '@/features/comments/context/commentTool';
import { countUnreadThreads, isThreadUnread } from '@/features/comments/lib/readState';
import { createDocumentId } from '@/features/itineraryPanel/lib/project/ids';
import { commentAuthorLabel } from '@/features/comments/lib/authorName';
import '@/features/comments/styles/comments.css';
import './styles.css';
import type { ViewerComments } from './viewerComments';

const noop = () => undefined;
const no = () => false;
const now = () => new Date().toISOString();

/**
 * Les composants de commentaire de l'app, pilotés par le contrôleur du viewer
 * via un `CommentToolValue` dont les écritures deviennent des actions du pont
 * (lecture seule quand l'onglet de l'app est fermé).
 */
export function ViewerCommentsUi({ controller }: { controller: ViewerComments }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { state, live, openThreadId, hoveredThreadId, draft, draftFocusRequest } = snapshot;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const members = useMemo(() => state?.members ?? [], [state?.members]);
  const membersStatus = state?.membersStatus;
  const nameOf = useCallback(
    (userId: string, fallback?: string) => commentAuthorLabel(userId, fallback, members, membersStatus),
    [members, membersStatus],
  );

  const tool = useMemo<CommentToolValue | null>(() => {
    if (!state) return null;
    const send = controller.sendAction.bind(controller);
    return {
      me: state.me,
      threads: state.threads,
      view: { reads: state.reads },
      members,
      nameOf,
      activeItinerary: null,
      armed: false,
      subTool: 'point',
      arm: noop,
      toggle: noop,
      deactivate: noop,
      statusMessage: null,
      openThreadId,
      openThread: (threadId) => controller.openThread(threadId),
      closeThread: () => controller.closeThread(),
      hoveredThreadId,
      setHoveredThreadId: (threadId) => controller.setHovered(threadId),
      draft,
      startDraft: (next) => controller.startDraft(next.anchor, next.zone),
      cancelDraft: () => controller.cancelDraft(),
      submitDraft: (input) => controller.submitDraft(input),
      draftTextRef: controller.draftTextRef,
      draftFocusRequest,
      dragZone: null,
      reply: (threadId, input) => send({ type: 'reply', threadId, messageId: createDocumentId('cmm'), text: input.text, mentions: input.mentions, at: now() }),
      editMessage: (threadId, messageId, input) => send({ type: 'edit-message', threadId, messageId, text: input.text, mentions: input.mentions, at: now() }),
      deleteMessage: (threadId, messageId) => send({ type: 'delete-message', threadId, messageId }),
      deleteThread: (threadId) => send({ type: 'delete-thread', threadId }),
      setResolved: (threadId, resolved) => send({ type: 'set-resolved', threadId, resolved, at: now() }),
      toggleReaction: (threadId, messageId, emoji) => send({ type: 'toggle-reaction', threadId, messageId, emoji }),
      moveThread: no,
      markUnread: (threadId) => controller.markUnread(threadId),
      setViewOptions: noop,
      pinsHidden: false,
      togglePinsHidden: noop,
      unreadCount: countUnreadThreads(state.threads, state.me.userId, state.reads),
      flyToThread: noop,
      navigate: (direction) => controller.navigate(direction),
      readOnly: !live,
    };
  }, [controller, draft, draftFocusRequest, hoveredThreadId, live, members, nameOf, openThreadId, state]);

  if (!state || !tool) return null;
  const threads = state.threads.filter((thread) => thread.resolvedAt === undefined || thread.id === openThreadId);
  const openThread = state.threads.find((thread) => thread.id === openThreadId) ?? null;

  return (
    <div className="rv-lidar-comments" data-rv-lidar-comments="">
      {threads.map((thread) => {
        const first = thread.messages[0];
        return (
          <div key={thread.id} ref={(element) => controller.registerPin(thread.id, element)} className="rv-lidar-comment-pin">
            <CommentPin
              thread={thread}
              authorName={nameOf(first?.authorId ?? thread.createdBy, first?.authorName)}
              unread={isThreadUnread(thread, state.me.userId, state.reads)}
              open={thread.id === openThreadId}
              highlighted={thread.id === hoveredThreadId}
              now={clock}
              onOpen={(threadId) => controller.openThread(threadId)}
              onHover={(threadId) => controller.setHovered(threadId)}
            />
          </div>
        );
      })}
      {draft ? (
        <div ref={(element) => controller.registerPin('draft', element)} className="rv-lidar-comment-pin">
          <CommentDraftPin userId={state.me.userId} name={state.me.name} />
        </div>
      ) : null}
      {draft || openThread ? (
        <div ref={(element) => controller.registerCard(element)} className="rv-lidar-comment-card">
          <div className="rv-lidar-comment-card__scale">
            {draft ? <CommentDraftCard tool={tool} /> : openThread ? <CommentThreadCard tool={tool} thread={openThread} now={clock} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
