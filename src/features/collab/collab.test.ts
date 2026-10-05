import { describe, expect, it } from 'vitest';

import { canonicalJson } from '@/features/itineraryPanel/lib/project/canonicalJson';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';
import type { Itinerary } from '@/features/itineraryPanel/types';

import { CollabClient } from './client/collabClient';
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

