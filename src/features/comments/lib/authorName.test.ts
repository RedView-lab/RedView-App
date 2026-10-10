import { describe, expect, it } from 'vitest';

import { readLidarCommentState } from '../bridge/lidarCommentChannel';
import { commentAuthorLabel } from './authorName';

const MEMBERS = [{ userId: 'alice', name: 'Alice' }, { userId: 'bob', name: 'Bob' }];

describe('commentAuthorLabel (A7-1)', () => {
  it('membre : le nom du compte, jamais celui choisi par l’auteur', () => {
    expect(commentAuthorLabel('bob', 'Victor (propriétaire)', MEMBERS, 'ready')).toBe('Bob');
  });

  it('projet partagé, auteur qui n’est plus membre : « Ancien éditeur », pas le nom qu’il s’était choisi', () => {
    expect(commentAuthorLabel('mallory', 'Victor (propriétaire)', MEMBERS, 'ready')).toBe('Ancien éditeur');
  });

  it('liste des membres pas encore lue : libellé neutre, en attendant', () => {
    expect(commentAuthorLabel('mallory', 'Victor (propriétaire)', MEMBERS, 'loading')).toBe('Éditeur');
  });

  it('projet non partagé (fichier importé) : le nom enregistré', () => {
    expect(commentAuthorLabel('editor-2', 'Éditeur 2', [], undefined)).toBe('Éditeur 2');
    expect(commentAuthorLabel('x', '', [], undefined)).toBe('Éditeur');
  });

  it('le visualiseur LiDAR reçoit l’état de la liste des membres', () => {
    const base = { type: 'STATE', projectId: 'p1', me: { userId: 'alice', name: 'Alice' }, members: MEMBERS, threads: [], reads: {} };
    expect(readLidarCommentState({ ...base, membersStatus: 'ready' })?.membersStatus).toBe('ready');
    expect(readLidarCommentState({ ...base, membersStatus: 'bogus' })?.membersStatus).toBeUndefined();
  });
});
