import { describe, expect, it } from 'vitest';

import type { ProjectCommentThread } from '@/features/itineraryPanel/types';

import { countUnreadThreads, isThreadUnread, isUserThread, markThreadRead, markThreadUnread, pruneReadMarks, threadMentionsUser } from './readState';

function thread(messages: Array<[id: string, author: string, at: string, mentions?: string[]]>): ProjectCommentThread {
  return {
    id: 'cm-1',
    anchor: { lng: 6.87, lat: 45.92, elevationM: null },
    createdBy: messages[0][1],
    createdAt: messages[0][2],
    messages: messages.map(([id, authorId, createdAt, mentions]) => ({ id, authorId, authorName: authorId, text: id, createdAt, ...(mentions ? { mentions } : {}) })),
  };
}

describe('lu / non lu', () => {
  it('un fil où personne d’autre n’a écrit n’est jamais non lu', () => {
    expect(isThreadUnread(thread([['m1', 'me', 't1']]), 'me', undefined)).toBe(false);
  });

  it('non lu tant que le dernier message d’un autre n’a pas été vu', () => {
    const t = thread([['m1', 'me', 't1'], ['m2', 'bob', 't2']]);
    expect(isThreadUnread(t, 'me', undefined)).toBe(true);
    const view = markThreadRead(undefined, t);
    expect(isThreadUnread(t, 'me', view.reads)).toBe(false);
    // Nouvelle réponse de bob : non lu ; la mienne : toujours lu.
    expect(isThreadUnread(thread([['m1', 'me', 't1'], ['m2', 'bob', 't2'], ['m3', 'bob', 't3']]), 'me', view.reads)).toBe(true);
    expect(isThreadUnread(thread([['m1', 'me', 't1'], ['m2', 'bob', 't2'], ['m3', 'me', 't3']]), 'me', view.reads)).toBe(false);
  });

  it('dernier message vu supprimé : la date prend le relais', () => {
    const view = markThreadRead(undefined, thread([['m1', 'me', 't1'], ['m2', 'bob', 't2']]));
    expect(isThreadUnread(thread([['m1', 'me', 't1'], ['m3', 'bob', 't1']]), 'me', view.reads)).toBe(false);
    expect(isThreadUnread(thread([['m1', 'me', 't1'], ['m3', 'bob', 't3']]), 'me', view.reads)).toBe(true);
  });

  it('marquer comme non lu, puis relire', () => {
    const t = thread([['m1', 'bob', 't1']]);
    const read = markThreadRead(undefined, t);
    expect(markThreadRead(read, t)).toBe(read);
    const unread = markThreadUnread(read, 'cm-1');
    expect(isThreadUnread(t, 'me', unread.reads)).toBe(true);
    expect(isThreadUnread(t, 'me', markThreadRead(unread, t).reads)).toBe(false);
  });

  it('mentions, « mes fils », compte des non lus (résolus exclus), repères purgés', () => {
    const t = thread([['m1', 'bob', 't1', ['me']]]);
    expect(threadMentionsUser(t, 'me')).toBe(true);
    expect(isUserThread(t, 'me')).toBe(true);
    expect(isUserThread(thread([['m1', 'bob', 't1']]), 'me')).toBe(false);
    expect(countUnreadThreads([t, { ...t, id: 'cm-2', resolvedAt: 't2' }], 'me', undefined)).toBe(1);
    const view = markThreadRead(undefined, t);
    expect(pruneReadMarks(view, [])!.reads).toEqual({});
    expect(pruneReadMarks(view, [t])).toBe(view);
  });
});
