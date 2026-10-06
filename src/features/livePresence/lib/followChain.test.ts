import { describe, expect, it } from 'vitest';

import { pickClientOfUser, resolveFollowTarget, type FollowPeer } from './followChain';

const peer = (clientId: string, following: string | null = null, userId = `u-${clientId}`): FollowPeer => ({ clientId, userId, following });

describe('chaîne de suivi', () => {
  it('suivre quelqu’un qui en suit un autre : on voit le bout de la chaîne', () => {
    const peers = [peer('me'), peer('b', 'c'), peer('c', 'd'), peer('d')];
    expect(resolveFollowTarget('b', peers, 'me')).toBe('d');
  });

  it('il me suit : on s’arrête à lui (jamais soi-même)', () => {
    const peers = [peer('me', 'b'), peer('b', 'me')];
    expect(resolveFollowTarget('b', peers, 'me')).toBe('b');
  });

  it('boucle entre d’autres : s’arrête au dernier éditeur valide', () => {
    const peers = [peer('me'), peer('b', 'c'), peer('c', 'b')];
    expect(resolveFollowTarget('b', peers, 'me')).toBe('c');
  });

  it('suivi d’un éditeur parti : la chaîne s’arrête avant ; éditeur suivi parti : null', () => {
    expect(resolveFollowTarget('b', [peer('me'), peer('b', 'gone')], 'me')).toBe('b');
    expect(resolveFollowTarget('gone', [peer('me')], 'me')).toBeNull();
    expect(resolveFollowTarget('me', [peer('me')], 'me')).toBeNull();
  });

  it('plusieurs onglets d’un même utilisateur : le plus récemment actif, jamais celui-ci', () => {
    const peers = [peer('me', null, 'u-1'), peer('t1', null, 'u-2'), peer('t2', null, 'u-2'), peer('t3', null, 'u-1')];
    const activity: Record<string, number> = { t1: 100, t2: 500, t3: 900 };
    expect(pickClientOfUser('u-2', peers, 'me', (id) => activity[id] ?? 0)).toBe('t2');
    expect(pickClientOfUser('u-1', peers, 'me', (id) => activity[id] ?? 0)).toBe('t3');
    expect(pickClientOfUser('u-9', peers, 'me', () => 0)).toBeNull();
  });
});
