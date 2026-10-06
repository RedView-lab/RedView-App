import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PeerInfo, PresenceState, PresenceUpdate } from '@/features/collab/protocol';
import type { CollabRealtime, MotionEvent } from '@/features/collab/realtime';

import { FOLLOW_GRACE_MS, SPOTLIGHT_COUNTDOWN_MS } from '../config';
import { LivePresenceSession, type CollabPresenceInput } from './LivePresenceSession';

const notifications = vi.hoisted(() => ({
  info: [] as string[],
  prompts: [] as Array<{ text: string; onAction?: () => void; onTimeout?: () => void; cancelled: boolean }>,
}));

vi.mock('@/shared/ui/notify', () => ({
  notify: {
    info: (text: string) => notifications.info.push(text),
    success: () => undefined,
    error: () => undefined,
    prompt: (text: string, _vars: unknown, options: { onAction?: () => void; onTimeout?: () => void }) => {
      const prompt = { text, onAction: options.onAction, onTimeout: options.onTimeout, cancelled: false };
      notifications.prompts.push(prompt);
      return () => {
        prompt.cancelled = true;
      };
    },
  },
}));

/** Session de co-édition factice : présence publiée gardée, `motion` injecté à la main. */
function fakeRealtime(clientId = 'me'): CollabRealtime & { presence: Partial<PresenceUpdate>; updates: Array<Partial<PresenceUpdate>>; emit(event: MotionEvent): void } {
  const listeners = new Set<(event: MotionEvent) => void>();
  const realtime = {
    clientId,
    presence: {} as Partial<PresenceUpdate>,
    updates: [] as Array<Partial<PresenceUpdate>>,
    subscribeMotion: (listener: (event: MotionEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendMotion: () => true,
    canSendVolatile: () => true,
    updatePresence: (patch: Partial<PresenceUpdate>) => {
      realtime.updates.push(patch);
      realtime.presence = { ...realtime.presence, ...patch };
    },
    emit: (event: MotionEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
  return realtime;
}

const peer = (clientId: string, userId: string, presence: PresenceState = {}): PeerInfo => ({ clientId, userId, presence: { name: userId, ...presence } });

function collab(peers: PeerInfo[], online = true): CollabPresenceInput {
  return { peers: [peer('me', 'u-me'), ...peers], self: { clientId: 'me', userId: 'u-me' }, online };
}

beforeEach(() => {
  vi.useFakeTimers();
  notifications.info.length = 0;
  notifications.prompts.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('présence en direct : suivre un éditeur', () => {
  it('suit l’onglet le plus actif de l’utilisateur, publie `following`, vue au bout de la chaîne', () => {
    const session = new LivePresenceSession();
    const realtime = fakeRealtime();
    session.setRealtime(realtime);
    session.setCollab(collab([peer('a1', 'alice', { following: 'c1' }), peer('a2', 'alice'), peer('c1', 'carol')]));
    realtime.emit({ from: 'a2', t: 10, fields: { ptr: [1, 2] }, snapshot: false });
    session.followUser('alice');
    const snapshot = session.getSnapshot();
    expect(snapshot.following).toMatchObject({ userId: 'alice', clientId: 'a2', name: 'alice' });
    expect(realtime.presence.following).toBe('a2');
    expect(snapshot.followTarget?.clientId).toBe('a2');
    // a1 (qui suit carol) devient le plus actif : le suivi reste sur l'onglet choisi.
    session.stopFollowing();
    realtime.emit({ from: 'a1', t: 20, fields: { ptr: [1, 2] }, snapshot: false });
    session.followUser('alice');
    expect(session.getSnapshot().following?.clientId).toBe('a1');
    expect(session.getSnapshot().followTarget?.clientId).toBe('c1');
    session.stopFollowing();
    expect(session.getSnapshot().following).toBeNull();
    expect(realtime.presence.following).toBeNull();
  });

  it('onglet suivi rechargé : passe à l’autre onglet du même utilisateur, sans arrêt', () => {
    const session = new LivePresenceSession();
    session.setRealtime(fakeRealtime());
    session.setCollab(collab([peer('a1', 'alice')]));
    session.followUser('alice');
    session.setCollab(collab([]));
    session.setCollab(collab([peer('a9', 'alice')]));
    vi.advanceTimersByTime(FOLLOW_GRACE_MS + 1);
    expect(session.getSnapshot().following?.clientId).toBe('a9');
    expect(notifications.info).toEqual([]);
  });

  it('éditeur suivi parti : arrêt après le délai de grâce, avec un message', () => {
    const session = new LivePresenceSession();
    session.setRealtime(fakeRealtime());
    session.setCollab(collab([peer('a1', 'alice')]));
    session.followUser('alice');
    session.setCollab(collab([]));
    vi.advanceTimersByTime(FOLLOW_GRACE_MS - 10);
    expect(session.getSnapshot().following).not.toBeNull();
    vi.advanceTimersByTime(20);
    expect(session.getSnapshot().following).toBeNull();
    expect(notifications.info).toEqual(['{{name}} a quitté le projet']);
  });

  it('hors ligne : le suivi est gardé (la reconnexion le reprend)', () => {
    const session = new LivePresenceSession();
    session.setRealtime(fakeRealtime());
    session.setCollab(collab([peer('a1', 'alice')]));
    session.followUser('alice');
    session.setCollab({ peers: [], self: { clientId: 'me', userId: 'u-me' }, online: false });
    vi.advanceTimersByTime(FOLLOW_GRACE_MS * 3);
    expect(session.getSnapshot().following?.clientId).toBe('a1');
    session.setCollab(collab([peer('a1', 'alice')]));
    expect(session.getSnapshot().followTarget?.clientId).toBe('a1');
  });

  it('autre session (autre projet) : rien ne survit', () => {
    const session = new LivePresenceSession();
    session.setRealtime(fakeRealtime());
    session.setCollab(collab([peer('a1', 'alice')]));
    session.followUser('alice');
    session.setPresenting(true);
    const next = fakeRealtime();
    session.setRealtime(next);
    session.setCollab(collab([peer('a1', 'alice')]));
    expect(session.getSnapshot()).toMatchObject({ following: null, presenting: false });
    expect(next.presence).toMatchObject({ following: null, spotlight: false });
  });
});

describe('présence en direct : Spotlight', () => {
  it('proposé une fois ; suivi au bout du compte à rebours ; arrêté avec la présentation', () => {
    const session = new LivePresenceSession();
    session.setRealtime(fakeRealtime());
    session.setCollab(collab([peer('a1', 'alice', { spotlight: 3 })]));
    session.setCollab(collab([peer('a1', 'alice', { spotlight: 3, activeItineraryId: 'it-2' })]));
    expect(notifications.prompts).toHaveLength(1);
    expect(session.getSnapshot().presenter?.clientId).toBe('a1');
    vi.advanceTimersByTime(SPOTLIGHT_COUNTDOWN_MS);
    notifications.prompts[0].onTimeout?.();
    expect(session.getSnapshot().following).toMatchObject({ userId: 'alice', viaSpotlight: true });
    session.setCollab(collab([peer('a1', 'alice', { spotlight: null })]));
    expect(session.getSnapshot().following).toBeNull();
    expect(notifications.info).toEqual(['{{name}} a arrêté de présenter']);
  });

  it('« Pas maintenant » : pas de suivi ; une nouvelle présentation est proposée à nouveau', () => {
    const session = new LivePresenceSession();
    session.setRealtime(fakeRealtime());
    session.setCollab(collab([peer('a1', 'alice', { spotlight: 3 })]));
    notifications.prompts[0].onAction?.();
    expect(session.getSnapshot().following).toBeNull();
    session.setCollab(collab([peer('a1', 'alice', { spotlight: null })]));
    session.setCollab(collab([peer('a1', 'alice', { spotlight: 5 })]));
    expect(notifications.prompts).toHaveLength(2);
  });

  it('déjà en train de le suivre : pas de proposition, le suivi devient celui de la présentation', () => {
    const session = new LivePresenceSession();
    session.setRealtime(fakeRealtime());
    session.setCollab(collab([peer('a1', 'alice')]));
    session.followUser('alice');
    session.setCollab(collab([peer('a1', 'alice', { spotlight: 1 })]));
    expect(notifications.prompts).toHaveLength(0);
    expect(session.getSnapshot().following?.viaSpotlight).toBe(true);
  });

  it('je présente : mon numéro, une fois donné par la salle, est publié (redonné à chaque reconnexion)', () => {
    const session = new LivePresenceSession();
    const realtime = fakeRealtime();
    session.setRealtime(realtime);
    session.setCollab(collab([peer('a1', 'alice')]));
    session.setPresenting(true);
    expect(realtime.presence.spotlight).toBe(true);
    session.setCollab({ peers: [peer('me', 'u-me', { spotlight: 1_791_000_000_000 }), peer('a1', 'alice')], self: { clientId: 'me', userId: 'u-me' }, online: true });
    expect(realtime.presence.spotlight).toBe(1_791_000_000_000);
    session.setPresenting(false);
    expect(realtime.presence.spotlight).toBe(false);
  });

  it('présentation d’un autre déclinée, puis il se reconnecte (même numéro) : pas reproposée', () => {
    const session = new LivePresenceSession();
    session.setRealtime(fakeRealtime());
    session.setCollab(collab([peer('a1', 'alice', { spotlight: 1_791_000_000_000 })]));
    expect(notifications.prompts).toHaveLength(1);
    notifications.prompts[0].onAction?.();
    session.setCollab(collab([]));
    session.setCollab(collab([peer('a1', 'alice', { spotlight: 1_791_000_000_000 })]));
    expect(notifications.prompts).toHaveLength(1);
    expect(session.getSnapshot().following).toBeNull();
  });

  it('je présente, quelqu’un présente après moi : ma présentation s’arrête, la sienne m’est proposée', () => {
    const session = new LivePresenceSession();
    const realtime = fakeRealtime();
    session.setRealtime(realtime);
    session.setCollab(collab([peer('a1', 'alice')]));
    session.setPresenting(true);
    expect(realtime.presence.spotlight).toBe(true);
    const withMine = (alice: number | null): CollabPresenceInput => ({
      peers: [peer('me', 'u-me', { spotlight: 4 }), peer('a1', 'alice', { spotlight: alice })],
      self: { clientId: 'me', userId: 'u-me' },
      online: true,
    });
    session.setCollab(withMine(null));
    expect(session.getSnapshot().presenting).toBe(true);
    session.setCollab(withMine(7));
    expect(session.getSnapshot().presenting).toBe(false);
    expect(realtime.presence.spotlight).toBe(false);
    expect(session.getSnapshot().presenter?.clientId).toBe('a1');
    expect(notifications.prompts).toHaveLength(1);
  });

  it('qui me suit : compté (le bandeau de présentation l’affiche)', () => {
    const session = new LivePresenceSession();
    session.setRealtime(fakeRealtime());
    session.setCollab(collab([peer('a1', 'alice', { following: 'me' }), peer('b1', 'bob')]));
    expect(session.getSnapshot().followers.map((follower) => follower.clientId)).toEqual(['a1']);
  });
});

describe('présence en direct : publication', () => {
  it('seuls les champs changés partent ; l’itinéraire actif est publié', () => {
    const session = new LivePresenceSession();
    const realtime = fakeRealtime();
    session.setRealtime(realtime);
    session.setCollab(collab([peer('a1', 'alice')]));
    const before = realtime.updates.length;
    session.setCollab(collab([peer('a1', 'alice', { activeItineraryId: 'it-1' })]));
    expect(realtime.updates.length).toBe(before);
    session.publishActiveItinerary('it-3');
    expect(realtime.updates[realtime.updates.length - 1]).toEqual({ activeItineraryId: 'it-3' });
    session.publishActiveItinerary('it-3');
    expect(realtime.updates[realtime.updates.length - 1]).toEqual({ activeItineraryId: 'it-3' });
    expect(realtime.updates.filter((update) => 'activeItineraryId' in update)).toHaveLength(2);
  });

  it('instantané stable tant que rien ne change (pas de rendu React inutile)', () => {
    const session = new LivePresenceSession();
    session.setRealtime(fakeRealtime());
    session.setCollab(collab([peer('a1', 'alice')]));
    const snapshot = session.getSnapshot();
    session.setCollab(collab([peer('a1', 'alice')]));
    expect(session.getSnapshot()).toBe(snapshot);
  });
});
