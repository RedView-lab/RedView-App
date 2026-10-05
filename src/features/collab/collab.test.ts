import { describe, expect, it } from 'vitest';

import { canonicalJson } from '@/features/itineraryPanel/lib/project/canonicalJson';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';
import type { Itinerary } from '@/features/itineraryPanel/types';

import { applyCommentAction } from '@/features/comments/lib/commentActions';

import { CollabClient } from './client/collabClient';
import type { UnsyncedBatch } from './client/syncEngine';
import { diffDocument } from './model/diff';
import { Materializer } from './model/materialize';
import type { Op } from './model/ops';
import { childObjectId, itineraryObjectId } from './model/paths';
import { checkBatch } from './model/validate';
import type { ClientMessage, ServerMessage } from './protocol';
import { AUTHOR_PRIORITY_MS, LeaseTable } from './room/leases';
import { Room, type RoomPeer } from './room/room';
import { RoomState } from './room/roomState';
import { sampleDocument } from './sim/fixtures';
import { Scheduler } from './sim/scheduler';
import { runSimulation } from './sim/simulator';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function mapIt(document: ProjectDocument, id: string, update: (it: Itinerary) => Itinerary): ProjectDocument {
  return {
    ...document,
    itineraries: (document.itineraries as Itinerary[]).map((it) => (it.id === id ? update(it) : it)),
  } as ProjectDocument;
}

function opsFor(state: RoomState, next: (document: ProjectDocument) => ProjectDocument) {
  const prev = state.document();
  const { ops, blobs } = diffDocument(state.store, prev, next(prev));
  return { ops, blobs: Object.fromEntries(blobs) };
}

describe('salle : ordre, validation, doublons', () => {
  it('numérote les lots, ignore un renvoi, refuse un lot invalide en entier', () => {
    const state = RoomState.fromDocument(sampleDocument(200), 0);
    const change = opsFor(state, (doc) => mapIt(doc, 'it-1', (it) => ({ ...it, name: 'A' })));
    const first = state.applyClientBatch({ clientId: 'a', clientSeq: 1, ...change }, 'u', 1);
    expect(first.kind).toBe('applied');
    expect(state.seq).toBe(1);
    expect(state.applyClientBatch({ clientId: 'a', clientSeq: 1, ...change }, 'u', 2).kind).toBe('duplicate');
    const invalid = state.applyClientBatch({
      clientId: 'a',
      clientSeq: 2,
      ops: [{ t: 's', id: itineraryObjectId('it-1'), k: 'name', v: 'B' }, { t: 'x' }],
      blobs: {},
    }, 'u', 3);
    expect(invalid.kind).toBe('rejected');
    expect((state.document().itineraries[1] as Itinerary).name).toBe('A');
    expect(state.seq).toBe(1);
  });

  it('deux insertions concurrentes à la même position : le serveur en décale une', () => {
    const state = RoomState.fromDocument(sampleDocument(0), 0);
    const parent = itineraryObjectId('it-1');
    const timeline = state.store.childrenOf(parent, 'timeline');
    const pos = `${timeline[1].pos}V`;
    const create = (key: string): Op => ({
      t: 'c', id: childObjectId(parent, 'timeline', key), parent, field: 'timeline', pos,
      props: [['id', key], ['kind', 'waypoint'], ['label', key]],
    });
    state.applyClientBatch({ clientId: 'a', clientSeq: 1, ops: [create('x')], blobs: {} }, 'u', 1);
    const outcome = state.applyClientBatch({ clientId: 'b', clientSeq: 1, ops: [create('y')], blobs: {} }, 'u', 2);
    expect(outcome.kind).toBe('applied');
    const positions = state.store.childrenOf(parent, 'timeline').map((child) => child.pos);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('refuse un élément créé hors d’une liste du modèle ou avec un id incohérent', () => {
    const state = RoomState.fromDocument(sampleDocument(0), 0);
    const parent = itineraryObjectId('it-1');
    expect(checkBatch(state.store, [{ t: 'c', id: `${parent}/name:x`, parent, field: 'name', pos: 'a0', props: [] }], {}).ok).toBe(false);
    expect(checkBatch(state.store, [{ t: 'c', id: 'p/autre:x', parent, field: 'timeline', pos: 'a0', props: [] }], {}).ok).toBe(false);
    expect(checkBatch(state.store, [{ t: 'm', id: childObjectId(parent, 'timeline', 'wp-a'), pos: '' }], {}).ok).toBe(false);
  });

  it('refuse un en-tête de tracé dont les segments manquent, et les liste', () => {
    const state = RoomState.fromDocument(sampleDocument(0), 0);
    const result = checkBatch(state.store, [{
      t: 's', id: itineraryObjectId('it-1'), k: 'gpxRoute', v: { v: 1, meta: {}, points: ['cabsent'] },
    }], {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.missingBlobs).toEqual(['cabsent']);
  });

  it('auteur des entrées : la dernière modification désigne qui recalcule', () => {
    const state = RoomState.fromDocument(sampleDocument(0), 0);
    state.applyClientBatch({ clientId: 'a', clientSeq: 1, ...opsFor(state, (doc) => mapIt(doc, 'it-1', (it) => ({ ...it, priorities: { ...it.priorities, elevation: 90 } }))) }, 'ua', 10);
    state.applyClientBatch({ clientId: 'b', clientSeq: 1, ...opsFor(state, (doc) => mapIt(doc, 'it-1', (it) => ({ ...it, color: '#000000' }))) }, 'ub', 20);
    expect(state.lastInputAuthor('route', 'it-1')?.clientId).toBe('a');
    state.applyClientBatch({ clientId: 'b', clientSeq: 2, ...opsFor(state, (doc) => mapIt(doc, 'it-1', (it) => ({ ...it, timeline: it.timeline.slice(0, 3) }))) }, 'ub', 30);
    expect(state.lastInputAuthor('route', 'it-1')?.clientId).toBe('b');
    expect(state.lastInputAuthor('route', 'it-2')).toBeUndefined();
  });
});

describe('baux de calcul', () => {
  const connected = (ids: string[]) => (clientId: string) => ids.includes(clientId);

  it('l’auteur connecté est prioritaire, puis le premier demandeur', () => {
    const table = new LeaseTable();
    const author = { clientId: 'a', userId: 'ua', at: 1_000 };
    const denied = table.request('route', 'it-1', { clientId: 'b', userId: 'ub' }, 1_500, { author, isConnected: connected(['a', 'b']) });
    expect(denied.granted).toBe(false);
    const granted = table.request('route', 'it-1', { clientId: 'a', userId: 'ua' }, 1_600, { author, isConnected: connected(['a', 'b']) });
    expect(granted.granted).toBe(true);
    // Auteur parti : le premier demandeur l'obtient tout de suite.
    const other = new LeaseTable();
    expect(other.request('route', 'it-1', { clientId: 'b', userId: 'ub' }, 1_500, { author, isConnected: connected(['b']) }).granted).toBe(true);
    // Priorité écoulée.
    const late = new LeaseTable();
    expect(late.request('route', 'it-1', { clientId: 'b', userId: 'ub' }, 1_000 + AUTHOR_PRIORITY_MS, { author, isConnected: connected(['a', 'b']) }).granted).toBe(true);
  });

  it('un seul titulaire ; libéré à la déconnexion', () => {
    const table = new LeaseTable();
    const context = { author: undefined, isConnected: connected(['a', 'b']) };
    expect(table.request('poi', 'it-1', { clientId: 'a', userId: 'ua' }, 0, context).granted).toBe(true);
    expect(table.request('poi', 'it-1', { clientId: 'b', userId: 'ub' }, 10, context).granted).toBe(false);
    expect(table.releaseClient('a')).toBe(true);
    expect(table.request('poi', 'it-1', { clientId: 'b', userId: 'ub' }, 20, context).granted).toBe(true);
  });
});

/** Salle + clients reliés sans latence (ordre exact des messages). */
function directSetup(clientIds: string[], document = sampleDocument(300)) {
  const scheduler = new Scheduler();
  const room = new Room(RoomState.fromDocument(document, 0), { epoch: 'e1', now: () => scheduler.now() });
  const clients = clientIds.map((clientId) => {
    let online = false;
    const inbox: ServerMessage[] = [];
    const peer: RoomPeer = { clientId, userId: `u-${clientId}`, send: (message) => inbox.push(JSON.parse(JSON.stringify(message)) as ServerMessage) };
    const client = new CollabClient({
      clientId,
      clock: scheduler,
      transport: {
        isOnline: () => online,
        send: (message: ClientMessage) => room.handle(clientId, JSON.parse(JSON.stringify(message)) as ClientMessage),
        requestFlush: () => undefined,
        resync: () => undefined,
      },
    });
    const deliver = () => {
      while (inbox.length > 0) {
        const message = inbox.shift()!;
        if (message.type === 'welcome') online = true;
        client.receive(message);
      }
    };
    room.join(peer, { epoch: null, lastSeq: null });
    deliver();
    return { client, deliver };
  });
  /** Envoie tout, livre tout, jusqu'à stabilité. */
  const settle = () => {
    for (let round = 0; round < 10; round += 1) {
      for (const { client } of clients) client.flush();
      for (const { deliver } of clients) deliver();
    }
  };
  return { room, clients: clients.map(({ client }) => client), deliver: clients.map(({ deliver }) => deliver), settle, scheduler };
}

describe('client : synchro et annuler par éditeur', () => {
  it('une modification distante garde les objets non touchés (références de l’application)', () => {
    const { clients: [a, b], settle } = directSetup(['a', 'b']);
    const before = b.getDocument();
    a.pushLocalDocument(mapIt(a.getDocument(), 'it-2', (it) => ({ ...it, color: '#3d8bff' })), 'user');
    settle();
    const after = b.getDocument();
    expect(after).not.toBe(before);
    expect(after.itineraries[1]).toBe(before.itineraries[1]);
    expect(after.itineraries[2]).not.toBe(before.itineraries[2]);
    expect((after.itineraries[1] as Itinerary).gpxRoute!.points).toBe((before.itineraries[1] as Itinerary).gpxRoute!.points);
  });

  it('une modification locale redonne au store ses propres objets', () => {
    const { clients: [a], settle } = directSetup(['a']);
    const next = mapIt(a.getDocument(), 'it-1', (it) => ({ ...it, name: 'Local' }));
    a.pushLocalDocument(next, 'user');
    settle();
    expect(a.getDocument()).toBe(next);
  });

  it('valeur distante masquée tant que la sienne n’est pas acquittée, puis ordre du serveur', () => {
    const { clients: [a, b], deliver: [, deliverB], settle } = directSetup(['a', 'b']);
    a.pushLocalDocument(mapIt(a.getDocument(), 'it-1', (it) => ({ ...it, name: 'A' })), 'user');
    b.pushLocalDocument(mapIt(b.getDocument(), 'it-1', (it) => ({ ...it, name: 'B' })), 'user');
    a.flush();
    // b reçoit le lot de a avant d'avoir envoyé le sien : il garde « B ».
    deliverB();
    expect((b.getDocument().itineraries[1] as Itinerary).name).toBe('B');
    settle();
    expect((a.getDocument().itineraries[1] as Itinerary).name).toBe('B');
    expect((b.getDocument().itineraries[1] as Itinerary).name).toBe('B');
  });

  it('annuler ne défait que ses propres modifications', () => {
    const { clients: [a, b], settle } = directSetup(['a', 'b']);
    a.pushLocalDocument(mapIt(a.getDocument(), 'it-1', (it) => ({ ...it, name: 'A1', color: '#111111' })), 'step');
    settle();
    b.pushLocalDocument(mapIt(b.getDocument(), 'it-1', (it) => ({ ...it, name: 'B1' })), 'step');
    settle();
    a.undo();
    settle();
    const it1 = a.getDocument().itineraries[1] as Itinerary;
    // La couleur de a est annulée ; le nom, changé ensuite par b, reste celui de b.
    expect(it1.color).toBe('#c50000');
    expect(it1.name).toBe('B1');
    expect(same(a.getDocument(), b.getDocument())).toBe(true);
    a.redo();
    settle();
    expect((b.getDocument().itineraries[1] as Itinerary).color).toBe('#111111');
  });

  it('annuler une suppression recrée l’élément avec toutes ses propriétés', () => {
    const { clients: [a, b], settle } = directSetup(['a', 'b']);
    const original = a.getDocument();
    a.pushLocalDocument({ ...original, itineraries: original.itineraries.filter((it) => it.id !== 'it-1') } as ProjectDocument, 'step');
    settle();
    expect(b.getDocument().itineraries.some((it) => it.id === 'it-1')).toBe(false);
    a.undo();
    settle();
    expect(same(b.getDocument(), original)).toBe(true);
  });

  it('résultat d’arrière-plan rattaché à l’action : annuler remet aussi l’ancien tracé', () => {
    const { clients: [a], settle } = directSetup(['a']);
    const original = a.getDocument();
    a.pushLocalDocument(mapIt(original, 'it-1', (it) => ({ ...it, timeline: it.timeline.slice(0, 3) })), 'step');
    const routed = mapIt(a.getDocument(), 'it-1', (it) => ({
      ...it,
      gpxRoute: { ...it.gpxRoute!, points: it.gpxRoute!.points.slice(0, 100), routedInputsKey: 'k1' },
    }));
    a.pushLocalDocument(routed, 'background');
    settle();
    a.undo();
    settle();
    expect(same(a.getDocument(), original)).toBe(true);
    expect(a.canUndo()).toBe(false);
  });

  it('suite d’actions puis tout annuler = document de départ ; tout rétablir = document final', () => {
    const { clients: [a], settle } = directSetup(['a']);
    const original = a.getDocument();
    let document = original;
    for (let index = 0; index < 12; index += 1) {
      document = mapIt(document, index % 2 ? 'it-1' : 'it-2', (it) => ({
        ...it,
        name: `n${index}`,
        timeline: index % 3 === 0 ? [...it.timeline.slice(0, 1), { id: `w${index}`, kind: 'waypoint', label: `w${index}`, distanceKm: null } as never, ...it.timeline.slice(1)] : it.timeline,
      }));
      a.pushLocalDocument(document, 'step');
      settle();
    }
    const final = a.getDocument();
    while (a.canUndo()) a.undo();
    settle();
    expect(same(a.getDocument(), original)).toBe(true);
    while (a.canRedo()) a.redo();
    settle();
    expect(same(a.getDocument(), final)).toBe(true);
  });

  it('un seul éditeur obtient le bail ; libéré après l’écriture du résultat', () => {
    const { clients: [a, b], settle, scheduler } = directSetup(['a', 'b']);
    scheduler.runUntil(10_000);
    expect(a.computeGate.shouldCompute('route', 'it-1')).toBe(false);
    expect(b.computeGate.shouldCompute('route', 'it-1')).toBe(false);
    settle();
    const holders = [a, b].filter((client) => client.computeGate.shouldCompute('route', 'it-1'));
    expect(holders).toHaveLength(1);
    const end = holders[0].computeGate.beginCompute('route', 'it-1');
    end();
    settle();
    expect(a.getState().leases).toHaveLength(0);
  });
});

/**
 * Salle + clients reliés sans latence, chacun branché puis connecté quand le
 * test le décide (connexion lente, onglet rechargé).
 */
function manualSetup(document = sampleDocument(300)) {
  const scheduler = new Scheduler();
  const room = new Room(RoomState.fromDocument(document, 0), { epoch: 'e1', now: () => scheduler.now() });
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const make = (clientId: string, restore?: { batches: UnsyncedBatch[]; nextSeq: number }) => {
    let online = false;
    const inbox: ServerMessage[] = [];
    const peer: RoomPeer = { clientId, userId: `u-${clientId}`, send: (message) => inbox.push(clone(message)) };
    const client = new CollabClient({
      clientId,
      clock: scheduler,
      transport: {
        isOnline: () => online,
        send: (message: ClientMessage) => {
          if (online) room.handle(clientId, clone(message));
        },
        requestFlush: () => undefined,
        resync: () => undefined,
      },
    });
    if (restore) client.engine.restoreUnsynced(restore.batches, restore.nextSeq);
    const deliver = () => {
      while (inbox.length > 0) {
        const message = inbox.shift()!;
        if (message.type === 'welcome') online = true;
        client.receive(message);
      }
    };
    return {
      client,
      deliver,
      join: () => {
        room.join(peer, { epoch: null, lastSeq: null });
        deliver();
      },
      leave: () => {
        online = false;
        room.leave(clientId, peer);
        client.disconnected(true);
      },
    };
  };
  return { room, make };
}

type ManualClient = ReturnType<ReturnType<typeof manualSetup>['make']>;

function settleAll(...clients: ManualClient[]): void {
  for (let round = 0; round < 10; round += 1) {
    for (const { client } of clients) client.flush();
    for (const { deliver } of clients) deliver();
  }
}

const itineraryOf = (document: ProjectDocument, id: string) => (document.itineraries as Itinerary[]).find((it) => it.id === id)!;

describe('connexion lente, branchement, onglet rechargé', () => {
  it('modification faite pendant la connexion : envoyée, rejouée sur l’état du serveur ; un calcul sur l’ancien document reste local', () => {
    const { room, make } = manualSetup();
    // Document du cloud (dernier point de sauvegarde), en retard sur la salle.
    const cloud = room.state.document();
    const a = make('a');
    a.client.bind(cloud, []);
    a.join();
    a.client.pushLocalDocument(mapIt(a.client.getDocument(), 'it-2', (it) => ({ ...it, name: 'A2' })), 'user');
    settleAll(a);

    const b = make('b');
    expect(b.client.bind(cloud, [])).toBe(cloud);
    b.client.pushLocalDocument(mapIt(b.client.getDocument(), 'it-1', (it) => ({ ...it, name: 'B pendant la connexion' })), 'user');
    b.client.pushLocalDocument(mapIt(b.client.getDocument(), 'it-1', (it) => ({
      ...it,
      gpxRoute: { ...it.gpxRoute!, points: it.gpxRoute!.points.slice(0, 50), routedInputsKey: 'calcul-ancien-document' },
    })), 'background');
    expect(b.client.getState().unsynced).toBe(1);
    b.join();
    settleAll(a, b);

    expect(itineraryOf(b.client.getDocument(), 'it-2').name).toBe('A2');
    expect(itineraryOf(a.client.getDocument(), 'it-1').name).toBe('B pendant la connexion');
    expect(itineraryOf(a.client.getDocument(), 'it-1').gpxRoute!.routedInputsKey).toBe('k0');
    expect(itineraryOf(b.client.getDocument(), 'it-1').gpxRoute!.routedInputsKey).toBe('k0');
    expect(same(a.client.getDocument(), b.client.getDocument())).toBe(true);
    // L'utilisateur peut annuler ce qu'il a fait pendant la connexion.
    expect(b.client.canUndo()).toBe(true);
  });

  it('écritures faites avant le branchement : rejouées chacune d’après la précédente', () => {
    const { room, make } = manualSetup();
    const cloud = room.state.document();
    const a = make('a');
    a.client.bind(cloud, []);
    a.join();
    a.client.pushLocalDocument(mapIt(a.client.getDocument(), 'it-1', (it) => ({ ...it, color: '#22aa55' })), 'user');
    settleAll(a);

    const renamed = mapIt(cloud, 'it-1', (it) => ({ ...it, name: 'Avant le branchement' }));
    const routed = mapIt(renamed, 'it-1', (it) => ({ ...it, gpxRoute: { ...it.gpxRoute!, routedInputsKey: 'local' } }));
    const recolored = mapIt(routed, 'it-2', (it) => ({ ...it, color: '#ffaa00' }));
    const b = make('b');
    const shown = b.client.bind(cloud, [
      { document: renamed, change: 'user' },
      { document: routed, change: 'background' },
      { document: recolored, change: 'step' },
    ]);
    expect(itineraryOf(shown, 'it-1').name).toBe('Avant le branchement');
    b.join();
    settleAll(a, b);

    const it1 = itineraryOf(a.client.getDocument(), 'it-1');
    expect(it1.name).toBe('Avant le branchement');
    // La couleur de A (changée après le point de sauvegarde) n'est pas écrasée.
    expect(it1.color).toBe('#22aa55');
    expect(it1.gpxRoute!.routedInputsKey).toBe('k0');
    expect(itineraryOf(a.client.getDocument(), 'it-2').color).toBe('#ffaa00');
    expect(same(a.client.getDocument(), b.client.getDocument())).toBe(true);
  });

  it('branchement après l’état du serveur : les écritures sont rejouées sur la session', () => {
    const { room, make } = manualSetup();
    const cloud = room.state.document();
    const a = make('a');
    a.client.bind(cloud, []);
    a.join();
    a.client.pushLocalDocument(mapIt(a.client.getDocument(), 'it-2', (it) => ({ ...it, name: 'A2' })), 'user');
    settleAll(a);

    const b = make('b');
    b.join();
    const local = mapIt(cloud, 'it-1', (it) => ({ ...it, name: 'B local' }));
    const shown = b.client.bind(cloud, [{ document: local, change: 'user' }]);
    expect(itineraryOf(shown, 'it-1').name).toBe('B local');
    expect(itineraryOf(shown, 'it-2').name).toBe('A2');
    settleAll(a, b);
    expect(itineraryOf(a.client.getDocument(), 'it-1').name).toBe('B local');
  });

  it('onglet fermé avec des lots non écrits : repris par la session suivante du même client, jamais appliqués deux fois', () => {
    const { room, make } = manualSetup();
    const cloud = room.state.document();
    const a = make('a');
    a.client.bind(cloud, []);
    a.join();
    // Lot 1 : appliqué par le serveur, acquittement jamais reçu (onglet fermé avant).
    a.client.pushLocalDocument(mapIt(a.client.getDocument(), 'it-1', (it) => ({ ...it, name: 'un' })), 'user');
    a.client.flush();
    // Lot 2 : fait hors ligne, jamais envoyé.
    a.leave();
    a.client.pushLocalDocument(mapIt(a.client.getDocument(), 'it-2', (it) => ({ ...it, name: 'deux' })), 'user');
    const unsynced = a.client.engine.unsyncedBatches();
    expect(unsynced.map((batch) => batch.clientSeq)).toEqual([1, 2]);

    // Entre-temps, un autre éditeur renomme it-1 : le lot 1 ne doit pas l'écraser une seconde fois.
    const b = make('b');
    b.client.bind(cloud, []);
    b.join();
    b.client.pushLocalDocument(mapIt(b.client.getDocument(), 'it-1', (it) => ({ ...it, name: 'B' })), 'user');
    settleAll(b);
    const seqBefore = room.state.seq;

    const reopened = make('a', { batches: unsynced, nextSeq: a.client.engine.nextSeq });
    const shown = reopened.client.bind(cloud, []);
    // Visible dès l'ouverture, avant l'état du serveur.
    expect(itineraryOf(shown, 'it-2').name).toBe('deux');
    reopened.join();
    settleAll(b, reopened);
    expect(room.state.seq).toBe(seqBefore + 1);
    expect(itineraryOf(b.client.getDocument(), 'it-1').name).toBe('B');
    expect(itineraryOf(b.client.getDocument(), 'it-2').name).toBe('deux');
    expect(reopened.client.getState().unsynced).toBe(0);
    expect(same(b.client.getDocument(), reopened.client.getDocument())).toBe(true);
  });

  it('refus du serveur : l’état reste « refusé » après la fermeture qui le suit', () => {
    const { room, make } = manualSetup();
    const a = make('a');
    a.client.bind(room.state.document(), []);
    a.client.denied('not-found');
    a.client.disconnected(false);
    expect(a.client.getState()).toMatchObject({ status: 'denied', deniedReason: 'not-found' });
  });
});

function withThread(document: ProjectDocument, userId: string, id: string, text: string): ProjectDocument {
  const comments = applyCommentAction(document.comments ?? [], {
    type: 'create-thread', threadId: id, messageId: `${id}-m`, anchor: { lng: 6.87, lat: 45.92, elevationM: null }, text, at: '2026-10-05T10:00:00.000Z',
  }, { userId, name: userId })!;
  return { ...document, comments: [...comments] };
}

describe('commentaires', () => {
  it('jamais dans annuler : annuler défait l’action d’avant, le commentaire reste', () => {
    const { clients: [a, b], settle } = directSetup(['a', 'b']);
    a.pushLocalDocument(mapIt(a.getDocument(), 'it-1', (it) => ({ ...it, name: 'Renommé' })), 'step');
    a.pushLocalDocument(withThread(a.getDocument(), 'u-a', 'cm-1', 'Col fermé'), 'comment');
    settle();
    expect(b.getDocument().comments?.[0].messages[0].text).toBe('Col fermé');
    a.undo();
    settle();
    expect((b.getDocument().itineraries[1] as Itinerary).name).toBe('Principal');
    expect(b.getDocument().comments).toHaveLength(1);
    expect(a.canUndo()).toBe(false);
  });

  it('posé pendant la connexion (et avant le branchement) : envoyé, jamais perdu au premier état', () => {
    const { room, make } = manualSetup();
    const cloud = room.state.document();
    const b = make('b');
    b.client.bind(cloud, [{ document: withThread(cloud, 'u-b', 'cm-avant', 'Avant le branchement'), change: 'comment' }]);
    b.client.pushLocalDocument(withThread(b.client.getDocument(), 'u-b', 'cm-pendant', 'Pendant la connexion'), 'comment');
    b.join();
    settleAll(b);
    expect(room.state.document().comments?.map((thread) => thread.id)).toEqual(['cm-avant', 'cm-pendant']);
  });

  it('écrire sur le commentaire d’un autre : lot refusé par le serveur, la valeur de l’auteur reste', () => {
    const { clients: [a, b], settle } = directSetup(['a', 'b']);
    a.pushLocalDocument(withThread(a.getDocument(), 'u-a', 'cm-1', 'Texte de A'), 'comment');
    settle();
    const forged = b.getDocument();
    b.pushLocalDocument({
      ...forged,
      comments: forged.comments!.map((thread) => ({ ...thread, messages: thread.messages.map((message) => ({ ...message, text: 'Réécrit par B' })) })),
    }, 'comment');
    settle();
    expect(a.getDocument().comments![0].messages[0].text).toBe('Texte de A');
    expect(b.getDocument().comments![0].messages[0].text).toBe('Texte de A');
  });
});

describe('simulateur : réseau perturbé, arrêts du serveur', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`graine ${seed} : convergence, journal = mémoire, aucune modification perdue`, () => {
      const report = runSimulation({ seed, clients: 3, durationMs: 20_000, routeSize: 400 });
      expect(report.failures).toEqual([]);
      expect(report.converged && report.durableMatchesMemory && report.countersIntact).toBe(true);
      expect(report.stats.edits).toBeGreaterThan(50);
    }, 60_000);
  }
});

describe('matérialisation partagée', () => {
  it('adopter un document puis rematérialiser : mêmes références', () => {
    const state = RoomState.fromDocument(sampleDocument(100), 0);
    const materializer = new Materializer();
    const document = state.document();
    materializer.adopt(state.store, document);
    expect(materializer.materialize(state.store)).toBe(document);
  });
});

