import { describe, expect, it } from 'vitest';

import { applyCommentAction, type CommentAction, type CommentAuthor } from '@/features/comments/lib/commentActions';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';
import type { ProjectCommentThread } from '@/features/itineraryPanel/types';

import { RoomState } from '../room/roomState';
import { sampleDocument } from '../sim/fixtures';
import { commentObjectKind } from './commentRules';
import { diffDocument } from './diff';
import type { Op } from './ops';

const alice: CommentAuthor = { userId: 'u-alice', name: 'Alice' };
const bob: CommentAuthor = { userId: 'u-bob', name: 'Bob' };
const anchor = { lng: 6.87, lat: 45.92, elevationM: 1035 };

function withComments(document: ProjectDocument, comments: readonly ProjectCommentThread[] | null): ProjectDocument {
  const next = { ...document } as ProjectDocument & { comments?: ProjectCommentThread[] };
  if (comments && comments.length > 0) next.comments = [...comments];
  else delete next.comments;
  return next;
}

let clientSeq = 0;

/** L'action de `me` (réducteur de l'app) envoyée à la salle comme le ferait son client. */
function send(state: RoomState, action: CommentAction, me: CommentAuthor) {
  const prev = state.document();
  const comments = applyCommentAction(prev.comments ?? [], action, me);
  expect(comments).not.toBeNull();
  const { ops, blobs } = diffDocument(state.store, prev, withComments(prev, comments));
  clientSeq += 1;
  return state.applyClientBatch({ clientId: me.userId, clientSeq, ops, blobs: Object.fromEntries(blobs) }, me.userId, clientSeq);
}

function forged(state: RoomState, ops: Op[], userId: string) {
  clientSeq += 1;
  return state.applyClientBatch({ clientId: `forge-${userId}`, clientSeq, ops, blobs: {} }, userId, clientSeq);
}

function aliceThread(): RoomState {
  const state = RoomState.fromDocument(sampleDocument(0), 0);
  expect(send(state, { type: 'create-thread', threadId: 'cm-1', messageId: 'm-1', anchor, text: 'Col fermé', at: 't0' }, alice).kind).toBe('applied');
  expect(send(state, { type: 'reply', threadId: 'cm-1', messageId: 'm-2', text: 'Ah bon ?', at: 't1' }, bob).kind).toBe('applied');
  return state;
}

const THREAD = 'p/comments:cm-1';
const ALICE_MESSAGE = `${THREAD}/messages:m-1`;
const BOB_MESSAGE = `${THREAD}/messages:m-2`;

describe('règles d’auteur des commentaires (serveur)', () => {
  it('reconnaît fils et messages', () => {
    expect(commentObjectKind(THREAD)).toBe('thread');
    expect(commentObjectKind(BOB_MESSAGE)).toBe('message');
    expect(commentObjectKind('p/itineraries:it-1')).toBeNull();
  });

  it('chaque action légitime de l’app passe, et le document suit', () => {
    const state = aliceThread();
    for (const [action, me] of [
      [{ type: 'toggle-reaction', threadId: 'cm-1', messageId: 'm-1', emoji: '👍' }, bob],
      [{ type: 'toggle-reaction', threadId: 'cm-1', messageId: 'm-1', emoji: '👍' }, alice],
      [{ type: 'edit-message', threadId: 'cm-1', messageId: 'm-2', text: 'Ah bon ?!', at: 't2' }, bob],
      [{ type: 'set-resolved', threadId: 'cm-1', resolved: true, at: 't3' }, bob],
      [{ type: 'set-resolved', threadId: 'cm-1', resolved: false, at: 't4' }, alice],
      [{ type: 'move-thread', threadId: 'cm-1', anchor: { ...anchor, lng: 6.9 } }, alice],
      [{ type: 'toggle-reaction', threadId: 'cm-1', messageId: 'm-1', emoji: '👍' }, bob],
      [{ type: 'delete-message', threadId: 'cm-1', messageId: 'm-2' }, bob],
    ] as Array<[CommentAction, CommentAuthor]>) {
      expect(send(state, action, me).kind).toBe('applied');
    }
    const thread = state.document().comments![0];
    expect(thread.anchor.lng).toBe(6.9);
    expect(thread.messages.map((message) => message.id)).toEqual(['m-1']);
    expect(thread.messages[0].reactions).toEqual({ '👍~u-alice': true });
    expect(send(state, { type: 'delete-thread', threadId: 'cm-1' }, alice).kind).toBe('applied');
    expect(state.document().comments).toBeUndefined();
  });

  it('refuse d’écrire au nom d’un autre ou sur le contenu d’un autre', () => {
    const state = aliceThread();
    const cases: Array<[Op[], string]> = [
      [[{ t: 's', id: ALICE_MESSAGE, k: 'text', v: 'Pirate' }], 'comment-not-author'],
      [[{ t: 'd', id: ALICE_MESSAGE }], 'comment-not-author'],
      [[{ t: 'd', id: THREAD }], 'comment-not-creator'],
      [[{ t: 's', id: THREAD, k: 'anchor', v: { ...anchor, lng: 0 } }], 'comment-not-creator'],
      [[{ t: 's', id: ALICE_MESSAGE, k: 'reactions.👍~u-alice', v: true }], 'comment-not-reactor'],
      [[{ t: 's', id: THREAD, k: 'resolvedBy', v: 'u-alice' }], 'comment-not-resolver'],
      [[{ t: 'c', id: `${THREAD}/messages:m-9`, parent: THREAD, field: 'messages', pos: 'a9', props: [['id', 'm-9'], ['authorId', 'u-alice'], ['text', 'Faux']] }], 'comment-not-author'],
      [[{ t: 'c', id: 'p/comments:cm-9', parent: 'p', field: 'comments', pos: 'a9', props: [['id', 'cm-9'], ['createdBy', 'u-alice'], ['anchor', anchor]] }], 'comment-not-creator'],
      [[{ t: 's', id: 'p', k: 'comments', v: [{ id: 'x' }] }], 'comment-bad-list'],
      [[{ t: 's', id: BOB_MESSAGE, k: 'text', v: 'x'.repeat(5_001) }], 'comment-bad-text'],
    ];
    for (const [ops, reason] of cases) {
      const outcome = forged(state, ops, bob.userId);
      expect(outcome.kind, JSON.stringify(ops)).toBe('rejected');
      expect(outcome.kind === 'rejected' && outcome.reason).toBe(reason);
    }
    expect(state.document().comments![0].messages[0].text).toBe('Col fermé');
  });

  it('une écriture sur un fil supprimé entre-temps passe sans effet', () => {
    const state = aliceThread();
    expect(send(state, { type: 'delete-thread', threadId: 'cm-1' }, alice).kind).toBe('applied');
    const late = forged(state, [
      { t: 's', id: BOB_MESSAGE, k: 'text', v: 'Trop tard' },
      { t: 'c', id: `${THREAD}/messages:m-3`, parent: THREAD, field: 'messages', pos: 'a3', props: [['id', 'm-3'], ['authorId', 'u-bob'], ['text', 'x']] },
    ], bob.userId);
    expect(late.kind).toBe('applied');
    expect(state.document().comments).toBeUndefined();
  });
});
