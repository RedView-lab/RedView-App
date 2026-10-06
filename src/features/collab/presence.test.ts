import { describe, expect, it } from 'vitest';

import { CollabClient } from './client/collabClient';
import type { ClientMessage, ServerMessage } from './protocol';
import type { MotionEvent } from './realtime';
import { Room, type MotionOutcome, type RoomPeer, type SendOptions } from './room/room';
import { RoomState } from './room/roomState';
import { sampleDocument } from './sim/fixtures';

const CAM = [6.8694, 45.9237, 13.5, -20, 60, 36.87];
const VP = [1600, 900, 64, 360, 300, 420, 0, 0, 0, 0];

/** Salle et pairs qui gardent chaque message reçu avec ses options d'envoi. */
function presenceSetup() {
  let now = 0;
  const outcomes: MotionOutcome[] = [];
  let batches = 0;
  const room = new Room(RoomState.fromDocument(sampleDocument(50), 0), {
    epoch: 'e1',
    now: () => now,
    onBatch: () => {
      batches += 1;
    },
    onMotion: (outcome) => outcomes.push(outcome),
  });
  const peers = new Map<string, { peer: RoomPeer; inbox: Array<{ message: ServerMessage; options?: SendOptions }> }>();
  const join = (clientId: string, presence?: unknown) => {
    const inbox: Array<{ message: ServerMessage; options?: SendOptions }> = [];
    const peer: RoomPeer = {
      clientId,
      userId: `u-${clientId}`,
      send: (message, options) => inbox.push({ message: JSON.parse(JSON.stringify(message)) as ServerMessage, options }),
    };
    peers.set(clientId, { peer, inbox });
    room.join(peer, { epoch: null, lastSeq: null, presence });
    return inbox;
  };
  const send = (clientId: string, message: unknown) => room.handle(clientId, message as ClientMessage);
  const motionsOf = (clientId: string) => peers.get(clientId)!.inbox.filter(({ message }) => message.type === 'motion');
  const lastPeers = (clientId: string) => {
    const list = peers.get(clientId)!.inbox.filter(({ message }) => message.type === 'peers');
    const last = list[list.length - 1]?.message;
    return last?.type === 'peers' ? last.peers : [];
  };
  return {
    room,
    join,
    send,
    motionsOf,
    lastPeers,
    outcomes,
    batches: () => batches,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('présence en direct : canal motion de la salle', () => {
  it('relayé tout de suite aux autres, jamais à l’émetteur, en éphémère, jamais journalisé', () => {
    const setup = presenceSetup();
    setup.join('a');
    setup.join('b');
    setup.join('c');
    setup.send('a', { type: 'motion', t: 10, cam: CAM, vp: VP, ptr: [6.87, 45.92] });
    expect(setup.motionsOf('a')).toHaveLength(0);
    for (const other of ['b', 'c']) {
      const [received] = setup.motionsOf(other);
      expect(received.message).toEqual({ type: 'motion', from: 'a', t: 10, cam: CAM, vp: VP, ptr: [6.87, 45.92] });
      expect(received.options?.volatile).toBe(true);
    }
    expect(setup.room.state.seq).toBe(0);
    expect(setup.batches()).toBe(0);
    expect(setup.outcomes).toEqual(['relayed']);
  });

  it('un arrivant reçoit le dernier état fusionné des autres (caméra de départ pour les suivre)', () => {
    const setup = presenceSetup();
    setup.join('a');
    setup.send('a', { type: 'motion', t: 10, cam: CAM, vp: VP, ptr: [6.87, 45.92] });
    setup.send('a', { type: 'motion', t: 20, ptr: null });
    const inbox = setup.join('b');
    const welcome = inbox[0].message;
    expect(welcome.type).toBe('welcome');
    if (welcome.type !== 'welcome') return;
    expect(welcome.motions).toEqual([{ clientId: 'a', t: 20, cam: CAM, vp: VP, ptr: null }]);
    // Le même client qui se reconnecte ne reçoit pas son propre état.
    const again = setup.join('a');
    const rewelcome = again[0].message;
    if (rewelcome.type !== 'welcome') throw new Error('welcome attendu');
    expect(rewelcome.motions).toBeUndefined();
  });

  it('au-delà du débit permis : jeté, sans erreur ni fermeture', () => {
    const setup = presenceSetup();
    setup.join('a');
    const inboxB = setup.join('b');
    for (let index = 0; index < 100; index += 1) setup.send('a', { type: 'motion', t: index, ptr: [1, 2] });
    expect(setup.motionsOf('b').length).toBeLessThan(100);
    expect(setup.outcomes).toContain('rate-limited');
    expect(inboxB.some(({ message }) => message.type === 'error')).toBe(false);
    // Le seau se remplit avec le temps.
    setup.advance(1000);
    const before = setup.motionsOf('b').length;
    setup.send('a', { type: 'motion', t: 2000, ptr: [1, 2] });
    expect(setup.motionsOf('b').length).toBe(before + 1);
  });

  it('message invalide : ignoré sans réponse', () => {
    const setup = presenceSetup();
    const inboxA = setup.join('a');
    setup.join('b');
    setup.send('a', { type: 'motion', t: 1, cam: [0, 0, 99, 0, 0, 36] });
    expect(setup.motionsOf('b')).toHaveLength(0);
    expect(setup.outcomes).toEqual(['invalid']);
    expect(inboxA.some(({ message }) => message.type === 'error')).toBe(false);
  });
});

describe('présence en direct : suivi et Spotlight', () => {
  it('Spotlight numéroté par la salle : le plus récent l’emporte, gardé tant qu’il est allumé', () => {
    const setup = presenceSetup();
    setup.join('a');
    setup.join('b');
    const spotlightOf = (clientId: string) => {
      setup.room.tick();
      return setup.lastPeers('a').find((peer) => peer.clientId === clientId)?.presence.spotlight ?? null;
    };
    setup.send('a', { type: 'presence', presence: { name: 'A', spotlight: true } });
    const first = spotlightOf('a')!;
    expect(first).toBeGreaterThan(0);
    setup.send('b', { type: 'presence', presence: { name: 'B', spotlight: true } });
    const second = spotlightOf('b')!;
    expect(second).toBeGreaterThan(first);
    // Une autre mise à jour de présence garde le numéro.
    setup.send('a', { type: 'presence', presence: { name: 'A', spotlight: true, following: null } });
    expect(spotlightOf('a')).toBe(first);
    setup.send('a', { type: 'presence', presence: { name: 'A', activeItineraryId: 'it-1' } });
    expect(spotlightOf('a')).toBe(first);
    setup.send('a', { type: 'presence', presence: { name: 'A', spotlight: false } });
    expect(spotlightOf('a')).toBeNull();
    setup.send('a', { type: 'presence', presence: { name: 'A', spotlight: true } });
    expect(spotlightOf('a')).toBeGreaterThan(second);
  });

  it('Spotlight : le présentateur qui se reconnecte garde son numéro ; un numéro du futur est refusé', () => {
    const setup = presenceSetup();
    setup.advance(10_000);
    setup.join('a');
    setup.join('b');
    const spotlightOf = (clientId: string) => {
      setup.room.tick();
      return setup.lastPeers('b').find((peer) => peer.clientId === clientId)?.presence.spotlight ?? null;
    };
    setup.send('a', { type: 'presence', presence: { name: 'A', spotlight: true } });
    const number = spotlightOf('a')!;
    // Coupure de A, retour avec son numéro dans `hello` : même présentation.
    setup.room.leave('a');
    setup.advance(2_000);
    setup.join('a', { name: 'A', spotlight: number });
    expect(spotlightOf('a')).toBe(number);
    // Un client ne peut pas se donner la priorité avec un numéro à venir.
    setup.room.leave('a');
    setup.join('a', { name: 'A', spotlight: number + 1_000_000 });
    const assigned = spotlightOf('a')!;
    expect(assigned).toBeGreaterThan(number);
    expect(assigned).toBeLessThan(number + 1_000_000);
  });

  it('`following` : un id de client valide ou null, rien d’autre', () => {
    const setup = presenceSetup();
    setup.join('a', { name: 'A', following: 'b' });
    setup.join('b', { name: 'B', following: '../x' });
    setup.room.tick();
    const peers = setup.lastPeers('a');
    expect(peers.find((peer) => peer.clientId === 'a')?.presence.following).toBe('b');
    expect(peers.find((peer) => peer.clientId === 'b')?.presence).not.toHaveProperty('following');
  });
});

describe('présence en direct : client', () => {
  function client() {
    const sent: ClientMessage[] = [];
    let online = false;
    const collab = new CollabClient({
      clientId: 'me',
      transport: {
        isOnline: () => online,
        send: (message) => sent.push(message),
        requestFlush: () => undefined,
        resync: () => undefined,
      },
    });
    collab.bind(sampleDocument(10) as never, []);
    const welcome = (motions?: unknown[]) => {
      online = true;
      const state = RoomState.fromDocument(sampleDocument(10), 0);
      collab.receive({
        type: 'welcome', v: 3, epoch: 'e', clientId: 'me', userId: 'u-me', seq: 0, durableSeq: 0, clientSeq: 0,
        snapshot: state.snapshot(), peers: [], leases: [], ...(motions ? { motions } : {}),
      } as ServerMessage);
    };
    return { collab, sent, welcome };
  }

  it('un message motion ne touche jamais l’état de la session (aucun rendu React à 30 Hz)', () => {
    const { collab, welcome } = client();
    welcome();
    const events: MotionEvent[] = [];
    collab.subscribeMotion((event) => events.push(event));
    let stateChanges = 0;
    collab.subscribeState(() => {
      stateChanges += 1;
    });
    const before = collab.getState();
    collab.receive({ type: 'motion', from: 'a', t: 5, ptr: [1, 2] });
    expect(events).toEqual([{ from: 'a', t: 5, fields: { ptr: [1, 2] }, snapshot: false }]);
    expect(collab.getState()).toBe(before);
    expect(stateChanges).toBe(0);
  });

  it('`welcome` : ce client connu de la salle, dernier état des autres donné comme instantané', () => {
    const { collab, welcome } = client();
    const events: MotionEvent[] = [];
    collab.subscribeMotion((event) => events.push(event));
    welcome([{ clientId: 'a', t: 7, cam: CAM, vp: VP }]);
    expect(collab.getState().self).toEqual({ clientId: 'me', userId: 'u-me' });
    expect(events).toEqual([{ from: 'a', t: 7, fields: { cam: CAM, vp: VP }, snapshot: true }]);
  });

  it('envoyé seulement en ligne', () => {
    const { collab, sent, welcome } = client();
    expect(collab.sendMotion(1, { ptr: [1, 2] })).toBe(false);
    welcome();
    expect(collab.sendMotion(2, { ptr: null })).toBe(true);
    expect(sent.filter((message) => message.type === 'motion')).toEqual([{ type: 'motion', t: 2, ptr: null }]);
  });
});
