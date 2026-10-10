import { describe, expect, it } from 'vitest';

import type { ProjectCommentThread } from '@/features/itineraryPanel/types';

import { anonymizeOtherCommentAuthors } from './anonymizeComments';

const THREADS: ProjectCommentThread[] = [
  {
    id: 't1',
    anchor: { lng: 6, lat: 45, elevationM: null },
    createdBy: 'bob',
    createdAt: '2026-10-10T08:00:00Z',
    resolvedBy: 'alice',
    resolvedAt: '2026-10-10T09:00:00Z',
    messages: [
      { id: 'm1', authorId: 'bob', authorName: 'Bob Martin', text: 'Ravito ici ? @Alice', createdAt: '2026-10-10T08:00:00Z', mentions: ['alice'], reactions: { '👍~alice': true, '🔥~carol': true } },
      { id: 'm2', authorId: 'alice', authorName: 'Alice', text: 'Oui, et @Bob Martin vérifie @Carol', createdAt: '2026-10-10T08:05:00Z', mentions: ['bob', 'carol'] },
      { id: 'm3', authorId: 'carol', authorName: 'Carol', text: 'ok', createdAt: '2026-10-10T08:06:00Z' },
    ],
  },
];

describe('anonymizeOtherCommentAuthors (G2-1)', () => {
  it('garde l’expéditeur, remplace identifiant, nom, mentions et réactions des autres', () => {
    const [thread] = anonymizeOtherCommentAuthors(THREADS, 'alice')!;
    const json = JSON.stringify(thread);
    expect(json).not.toMatch(/bob|carol|Bob Martin|Carol/);
    expect(thread.createdBy).toBe('editor-2');
    expect(thread.resolvedBy).toBe('alice');
    expect(thread.messages[0]).toMatchObject({ authorId: 'editor-2', authorName: 'Éditeur 2', mentions: ['alice'] });
    expect(Object.keys(thread.messages[0].reactions!)).toEqual(['👍~alice', '🔥~editor-3']);
    expect(thread.messages[1]).toMatchObject({ authorId: 'alice', authorName: 'Alice', text: 'Oui, et @Éditeur 2 vérifie @Éditeur 3', mentions: ['editor-2', 'editor-3'] });
    expect(thread.messages[2]).toMatchObject({ authorId: 'editor-3', authorName: 'Éditeur 3' });
  });

  it('sans utilisateur connu : tous les auteurs sont pseudonymisés ; sans commentaires : rien', () => {
    const json = JSON.stringify(anonymizeOtherCommentAuthors(THREADS, null));
    expect(json).not.toMatch(/"alice"|bob|carol/);
    expect(anonymizeOtherCommentAuthors(undefined, 'alice')).toBeUndefined();
  });
});
