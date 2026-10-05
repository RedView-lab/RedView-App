import type {
  ProjectCommentReadMark,
  ProjectCommentsView,
  ProjectCommentThread,
} from '@/features/itineraryPanel/types';

/**
 * Lu / non lu des fils, par utilisateur (couche vue : `commentsView.reads`).
 * Un fil est non lu quand un autre a écrit après le dernier message que
 * l'utilisateur a vu, ou qu'il l'a « marqué comme non lu ». Le repère est
 * l'id du dernier message vu (ordre du serveur, indépendant des horloges) ;
 * sa date sert si ce message a été supprimé depuis.
 */

type Reads = ProjectCommentsView['reads'];

export function isThreadUnread(thread: ProjectCommentThread, userId: string, reads: Reads): boolean {
  const mark = reads?.[thread.id];
  if (mark?.unread) return true;
  if (!thread.messages.some((message) => message.authorId !== userId)) return false;
  if (!mark) return true;
  if (mark.m) {
    const index = thread.messages.findIndex((message) => message.id === mark.m);
    if (index >= 0) return thread.messages.slice(index + 1).some((message) => message.authorId !== userId);
  }
  if (mark.t) {
    const seenAt = mark.t;
    return thread.messages.some((message) => message.authorId !== userId && message.createdAt > seenAt);
  }
  return true;
}

/** L'utilisateur est mentionné dans le fil. */
export function threadMentionsUser(thread: ProjectCommentThread, userId: string): boolean {
  return thread.messages.some((message) => message.authorId !== userId && message.mentions?.includes(userId));
}

/** Fil créé par l'utilisateur, où il a répondu ou où il est mentionné (« Seulement mes fils »). */
export function isUserThread(thread: ProjectCommentThread, userId: string): boolean {
  return thread.createdBy === userId
    || thread.messages.some((message) => message.authorId === userId || message.mentions?.includes(userId));
}

function readMarkOf(thread: ProjectCommentThread): ProjectCommentReadMark {
  const last = thread.messages[thread.messages.length - 1];
  return last ? { m: last.id, t: last.createdAt } : {};
}

/** Vue avec le fil marqué lu jusqu'à son dernier message (la même vue si rien ne change). */
export function markThreadRead(view: ProjectCommentsView | undefined, thread: ProjectCommentThread): ProjectCommentsView {
  const current = view?.reads?.[thread.id];
  const mark = readMarkOf(thread);
  if (view && current && !current.unread && current.m === mark.m && current.t === mark.t) return view;
  return { ...view, reads: { ...view?.reads, [thread.id]: mark } };
}

export function markThreadUnread(view: ProjectCommentsView | undefined, threadId: string): ProjectCommentsView {
  if (view?.reads?.[threadId]?.unread) return view;
  return { ...view, reads: { ...view?.reads, [threadId]: { unread: true } } };
}

/** Repères des fils supprimés retirés (la vue reste petite). */
export function pruneReadMarks(view: ProjectCommentsView | undefined, threads: readonly ProjectCommentThread[]): ProjectCommentsView | undefined {
  const reads = view?.reads;
  if (!view || !reads) return view;
  const alive = new Set(threads.map((thread) => thread.id));
  const stale = Object.keys(reads).filter((id) => !alive.has(id));
  if (stale.length === 0) return view;
  const next = { ...reads };
  for (const id of stale) delete next[id];
  return { ...view, reads: next };
}

/** Nombre de fils non lus (résolus exclus). */
export function countUnreadThreads(threads: readonly ProjectCommentThread[] | undefined, userId: string, reads: Reads): number {
  let count = 0;
  for (const thread of threads ?? []) {
    if (thread.resolvedAt === undefined && isThreadUnread(thread, userId, reads)) count += 1;
  }
  return count;
}
