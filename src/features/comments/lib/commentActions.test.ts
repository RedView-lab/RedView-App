import { describe, expect, it } from 'vitest';

import type { ProjectCommentThread } from '@/features/itineraryPanel/types';

import { applyCommentAction, groupReactions, type CommentAuthor } from './commentActions';

const alice: CommentAuthor = { userId: 'u-alice', name: 'Alice' };
const bob: CommentAuthor = { userId: 'u-bob', name: 'Bob' };
const anchor = { lng: 6.87, lat: 45.92, elevationM: 1035 };

function created(): readonly ProjectCommentThread[] {
  return applyCommentAction([], {
    type: 'create-thread', threadId: 'cm-1', messageId: 'msg-1', anchor, text: '  Col fermé l’hiver  ', at: '2026-10-05T10:00:00.000Z',
  }, alice)!;
}

describe('applyCommentAction', () => {
  it('crée un fil au nom de son auteur, texte nettoyé', () => {
    const threads = created();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: 'cm-1', createdBy: 'u-alice', anchor });
    expect(threads[0].messages[0]).toMatchObject({ authorId: 'u-alice', authorName: 'Alice', text: 'Col fermé l’hiver' });
  });

  it('refuse un texte vide ou un id déjà pris', () => {
    expect(applyCommentAction([], { type: 'create-thread', threadId: 'x', messageId: 'm', anchor, text: '   ', at: 't' }, alice)).toBeNull();
    expect(applyCommentAction(created(), { type: 'create-thread', threadId: 'cm-1', messageId: 'm', anchor, text: 'a', at: 't' }, alice)).toBeNull();
  });

  it('répondre ajoute un message et rouvre un fil résolu', () => {
    const resolved = applyCommentAction(created(), { type: 'set-resolved', threadId: 'cm-1', resolved: true, at: 't1' }, bob)!;
    expect(resolved[0]).toMatchObject({ resolvedAt: 't1', resolvedBy: 'u-bob' });
    const replied = applyCommentAction(resolved, { type: 'reply', threadId: 'cm-1', messageId: 'msg-2', text: 'Ok !', mentions: ['u-alice', 'u-bob'], at: 't2' }, bob)!;
    expect(replied[0].resolvedAt).toBeUndefined();
    expect(replied[0].messages.map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
    // On ne se mentionne pas soi-même.
    expect(replied[0].messages[1].mentions).toEqual(['u-alice']);
  });

  it('seul l’auteur modifie ou supprime son message', () => {
    const replied = applyCommentAction(created(), { type: 'reply', threadId: 'cm-1', messageId: 'msg-2', text: 'Bob', at: 't2' }, bob)!;
    expect(applyCommentAction(replied, { type: 'edit-message', threadId: 'cm-1', messageId: 'msg-2', text: 'Pirate', at: 't3' }, alice)).toBeNull();
    const edited = applyCommentAction(replied, { type: 'edit-message', threadId: 'cm-1', messageId: 'msg-2', text: 'Bob 2', at: 't3' }, bob)!;
    expect(edited[0].messages[1]).toMatchObject({ text: 'Bob 2', editedAt: 't3' });
    expect(applyCommentAction(edited, { type: 'delete-message', threadId: 'cm-1', messageId: 'msg-2' }, alice)).toBeNull();
    const deleted = applyCommentAction(edited, { type: 'delete-message', threadId: 'cm-1', messageId: 'msg-2' }, bob)!;
    expect(deleted[0].messages).toHaveLength(1);
  });

  it('supprimer le premier message supprime le fil ; seul son créateur supprime ou déplace le fil', () => {
    const threads = created();
    expect(applyCommentAction(threads, { type: 'delete-thread', threadId: 'cm-1' }, bob)).toBeNull();
    expect(applyCommentAction(threads, { type: 'move-thread', threadId: 'cm-1', anchor: { ...anchor, lng: 7 } }, bob)).toBeNull();
    expect(applyCommentAction(threads, { type: 'delete-message', threadId: 'cm-1', messageId: 'msg-1' }, alice)).toEqual([]);
  });

  it('déplacer un fil de zone déplace sa zone', () => {
    const threads = applyCommentAction([], {
      type: 'create-thread', threadId: 'cm-z', messageId: 'm', anchor, text: 'Zone', at: 't',
      zone: { ring: [[6.8, 45.9], [6.9, 45.9], [6.9, 46]] },
    }, alice)!;
    const moved = applyCommentAction(threads, { type: 'move-thread', threadId: 'cm-z', anchor: { ...anchor, lng: anchor.lng + 0.1 } }, alice)!;
    expect(moved[0].zone!.ring[0][0]).toBeCloseTo(6.9);
    expect(moved[0].zone!.ring[0][1]).toBeCloseTo(45.9);
  });

  it('réactions : chacun pose et retire la sienne', () => {
    let threads = created();
    threads = applyCommentAction(threads, { type: 'toggle-reaction', threadId: 'cm-1', messageId: 'msg-1', emoji: '👍' }, alice)!;
    threads = applyCommentAction(threads, { type: 'toggle-reaction', threadId: 'cm-1', messageId: 'msg-1', emoji: '👍' }, bob)!;
    expect(groupReactions(threads[0].messages[0])).toEqual([{ emoji: '👍', userIds: ['u-alice', 'u-bob'] }]);
    threads = applyCommentAction(threads, { type: 'toggle-reaction', threadId: 'cm-1', messageId: 'msg-1', emoji: '👍' }, alice)!;
    threads = applyCommentAction(threads, { type: 'toggle-reaction', threadId: 'cm-1', messageId: 'msg-1', emoji: '👍' }, bob)!;
    // Plus aucune réaction : le champ disparaît.
    expect(threads[0].messages[0].reactions).toBeUndefined();
  });

  it('une action sans effet rend null', () => {
    const threads = created();
    expect(applyCommentAction(threads, { type: 'set-resolved', threadId: 'cm-1', resolved: false, at: 't' }, alice)).toBeNull();
    expect(applyCommentAction(threads, { type: 'edit-message', threadId: 'cm-1', messageId: 'msg-1', text: 'Col fermé l’hiver', at: 't' }, alice)).toBeNull();
    expect(applyCommentAction(threads, { type: 'reply', threadId: 'absent', messageId: 'm', text: 'a', at: 't' }, alice)).toBeNull();
  });
});
