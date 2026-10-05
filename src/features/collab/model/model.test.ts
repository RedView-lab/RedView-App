import { describe, expect, it } from 'vitest';

import { canonicalJson } from '@/features/itineraryPanel/lib/project/canonicalJson';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';
import type { Itinerary } from '@/features/itineraryPanel/types';

import { diffDocument, documentOps } from './diff';
import { randomEdit, sampleDocument } from '../sim/fixtures';
import { seededRandom } from '../sim/scheduler';
import { Materializer, materializeJson } from './materialize';
import { ObjectStore } from './objects';
import { applyOps, invertOps, type Op } from './ops';
import { childObjectId, itineraryIdOf, itineraryObjectId } from './paths';

type Point = { lat: number; lon: number; distanceM: number; elevationM: number };

function route(count: number, offset = 0): Point[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: 45.9 + (i + offset) * 0.0002,
    lon: 6.87 + i * 0.00015,
    distanceM: i * 19.7,
    elevationM: 1000 + Math.sin(i / 30) * 300,
  }));
}

function itinerary(id: string, name: string, points = 0): Itinerary {
  return {
    id,
    name,
    color: '#c50000',
    profileId: 'road',
    priorities: { duration: 50, elevation: 50, distance: 50, tranquility: 50 },
    roadTypes: { road: 'prefer', gravel: 'avoid', applyToAllItineraries: false } as never,
    rhythm: {
      startTime: '09:30',
      pauseIntervals: [{ id: 'pause-1', label: 'Pause 1', durationMin: 5, intervalMin: 60 }],
      pausePositionOverridesKm: {},
      poiPauseDurations: { fountains: 10, toilets: null },
    } as never,
    poi: { fountains: { enabled: true, distanceM: 20 } } as never,
    timeline: [
      { id: 'start', kind: 'start', label: 'Chamonix', distanceKm: 0, lat: 45.92, lon: 6.87 },
      { id: 'wp-a', kind: 'waypoint', label: 'Col A', distanceKm: 12, lat: 45.95, lon: 6.9 },
      { id: 'wp-b', kind: 'waypoint', label: 'Col B', distanceKm: 30, lat: 45.98, lon: 6.95 },
      { id: 'end', kind: 'end', label: 'Annecy', distanceKm: null, lat: 45.9, lon: 6.12 },
    ],
    forbiddenZones: [],
    steepAlertOverrides: { '45.92,6.87|46.01': { kind: 'warning' } },
    fitUploads: [{ name: 'ride.fit', type: 'x', lastModified: 1, size: 10, path: 'u/ride.fit' }],
    gpxRoute: points > 0 ? { name: null, source: 'brouter', points, routedInputsKey: 'k0' } as never : undefined,
  } as Itinerary;
}

function doc(points = 1200): ProjectDocument {
  return {
    schema: 2,
    name: 'Tour du Mont-Blanc',
    savedAt: null,
    sizeBytes: null,
    privacy: 'private',
    itineraries: [
      { ...itinerary('it-1', 'Principal'), gpxRoute: { name: null, source: 'brouter', points: route(points), routedInputsKey: 'k0' } } as never,
      itinerary('it-2', 'Variante'),
    ],
  };
}

function build(document: ProjectDocument): ObjectStore {
  const store = new ObjectStore();
  const { ops, blobs } = documentOps(store, document);
  for (const [id, json] of blobs) store.putBlob(id, json);
  applyOps(store, ops);
  return store;
}

function change(store: ObjectStore, prev: ProjectDocument, next: ProjectDocument): Op[] {
  const { ops, blobs } = diffDocument(store, prev, next);
  for (const [id, json] of blobs) store.putBlob(id, json);
  applyOps(store, ops);
  return ops;
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const mapIt = (d: ProjectDocument, id: string, fn: (it: Itinerary) => Itinerary): ProjectDocument => ({
  ...d,
  itineraries: d.itineraries.map((it) => (it.id === id ? (fn(it as Itinerary) as typeof it) : it)),
});

describe('document à plat', () => {
  it('aller-retour document → objets → document identique', () => {
    const source = doc();
    const store = build(source);
    expect(same(new Materializer().materialize(store), source)).toBe(true);
  });

  it('ids dérivés du document, clés avec points et deux-points échappées', () => {
    expect(itineraryIdOf(childObjectId(itineraryObjectId('it:1'), 'timeline', 'wp.a'))).toBe('it:1');
    const source = doc(10);
    const store = build(source);
    const object = store.get(itineraryObjectId('it-1'))!;
    expect([...object.props.keys()].some((key) => key.startsWith('steepAlertOverrides.45%2E92'))).toBe(true);
  });

  it('valeurs vides et atomiques gardées telles quelles', () => {
    const source = mapIt(doc(10), 'it-2', (it) => ({ ...it, forbiddenZones: [], rhythm: { ...it.rhythm, pausePositionOverridesKm: {} }, prediction: null }));
    expect(same(new Materializer().materialize(build(source)), source)).toBe(true);
  });

  it('modifications → opérations minimales, puis inverse', () => {
    const prev = doc(800);
    const store = build(prev);
    const before = store.clone();
    const next = mapIt(prev, 'it-1', (it) => ({
      ...it,
      name: 'Renommé',
      priorities: { ...it.priorities, elevation: 90 },
      timeline: [it.timeline[0], { ...it.timeline[2], label: 'Col B modifié' }, it.timeline[1], it.timeline[3]],
    }));
    const { ops } = diffDocument(store, prev, next);
    const inverse = invertOps(store, ops);
    change(store, prev, next);
    expect(same(new Materializer().materialize(store), next)).toBe(true);
    expect(ops.filter((op) => op.t === 'm')).toHaveLength(1);
    expect(ops.filter((op) => op.t === 's').map((op) => (op as { k: string }).k).sort()).toEqual(['label', 'name', 'priorities.elevation']);
    applyOps(store, inverse);
    expect(same(new Materializer().materialize(store), new Materializer().materialize(before))).toBe(true);
  });

  it('ajout, suppression d’éléments et d’itinéraire, inverse exact', () => {
    const prev = doc(300);
    const store = build(prev);
    const snapshot = new Materializer().materialize(store.clone());
    const next: ProjectDocument = {
      ...mapIt(prev, 'it-1', (it) => ({
        ...it,
        timeline: [...it.timeline.slice(0, 2), { id: 'wp-new', kind: 'waypoint', label: 'Nouveau', distanceKm: null }, ...it.timeline.slice(2)],
        rhythm: { ...it.rhythm, pauseIntervals: [] },
      })),
      itineraries: [prev.itineraries[0], itinerary('it-3', 'Ajouté')],
    };
    const fixed = { ...next, itineraries: [mapIt(next, 'it-1', (it) => it).itineraries[0], next.itineraries[1]] };
    const { ops } = diffDocument(store, prev, fixed);
    const inverse = invertOps(store, ops);
    change(store, prev, fixed);
    expect(same(new Materializer().materialize(store), fixed)).toBe(true);
    applyOps(store, inverse);
    expect(same(new Materializer().materialize(store), snapshot)).toBe(true);
  });

  it('réglage modifié : ses listes imbriquées gardent leurs éléments', () => {
    const prev = doc(10);
    const store = build(prev);
    const withPause = mapIt(prev, 'it-1', (it) => ({
      ...it,
      rhythm: { ...it.rhythm, pauseIntervals: [...it.rhythm.pauseIntervals, { id: 'pause-2', label: 'Pause 2', durationMin: 10, intervalMin: 90 }] },
    }));
    const ops = change(store, prev, withPause);
    expect(ops.filter((op) => op.t === 'd')).toHaveLength(0);
    const startTime = mapIt(withPause, 'it-1', (it) => ({ ...it, rhythm: { ...it.rhythm, startTime: '07:00' } }));
    expect(change(store, withPause, startTime)).toHaveLength(1);
    expect(same(new Materializer().materialize(store), startTime)).toBe(true);
  });

  it('tracé en segments : une fenêtre modifiée n’envoie que ses segments', () => {
    const prev = doc(20_000);
    const store = build(prev);
    const points = [...(prev.itineraries[0] as Itinerary).gpxRoute!.points];
    points.splice(10_000, 200, ...route(210, 777).map((p) => ({ ...p, lat: p.lat + 0.01 })));
    const next = mapIt(prev, 'it-1', (it) => ({ ...it, gpxRoute: { ...it.gpxRoute!, points, routedInputsKey: 'k1' } }));
    const { blobs } = diffDocument(store, prev, next);
    const sent = [...blobs.values()].reduce((sum, json) => sum + json.length, 0);
    expect(sent).toBeLessThan(JSON.stringify(points).length * 0.05);
    change(store, prev, next);
    expect(same(new Materializer().materialize(store), next)).toBe(true);
  });

  it('partage de structure : un itinéraire non touché garde son objet', () => {
    const prev = doc(500);
    const store = build(prev);
    const materializer = new Materializer();
    const first = materializer.materialize(store);
    change(store, prev, mapIt(prev, 'it-2', (it) => ({ ...it, color: '#3d8bff' })));
    const second = materializer.materialize(store);
    expect(second).not.toBe(first);
    expect(second.itineraries[0]).toBe(first.itineraries[0]);
    expect(second.itineraries[1]).not.toBe(first.itineraries[1]);
  });

  it('opérations sur un objet supprimé : sans effet', () => {
    const store = build(doc(10));
    applyOps(store, [{ t: 'd', id: itineraryObjectId('it-2') }]);
    const applied = applyOps(store, [{ t: 's', id: itineraryObjectId('it-2'), k: 'name', v: 'x' }]);
    expect(applied).toHaveLength(0);
    expect(store.has(childObjectId(itineraryObjectId('it-2'), 'timeline', 'start'))).toBe(false);
  });

  it('JSON du document sans le construire : identique à celui du document matérialisé', () => {
    // Clés entières (ordre propre aux objets JS), tracé avec points d'origine, puis modifications au hasard.
    let document = mapIt(doc(900), 'it-1', (it) => ({
      ...it,
      steepAlertOverrides: { zeta: { kind: 'a' }, '12': { kind: 'b' }, '3': { kind: 'c' } } as never,
      gpxRoute: { ...it.gpxRoute!, originalPoints: route(300, 7) } as never,
    }));
    const store = build(document);
    expect(materializeJson(store)).toBe(JSON.stringify(new Materializer().materialize(store)));
    const random = seededRandom(7);
    let sample = sampleDocument(600);
    const sampleStore = build(sample);
    for (let n = 0; n < 300; n += 1) {
      const edit = randomEdit(sample, random, 'c0', n);
      if (!edit) continue;
      change(sampleStore, sample, edit.document);
      sample = edit.document;
      if (n % 30 === 0) expect(materializeJson(sampleStore)).toBe(JSON.stringify(new Materializer().materialize(sampleStore)));
    }
    expect(materializeJson(sampleStore)).toBe(JSON.stringify(new Materializer().materialize(sampleStore)));
    // Segment absent : tracé vide des deux côtés.
    document = mapIt(document, 'it-2', (it) => ({ ...it, gpxRoute: { name: null, source: 'brouter', points: route(80, 3), routedInputsKey: 'k' } as never }));
    const partial = build(document);
    partial.pruneBlobs(new Set());
    expect(materializeJson(partial)).toBe(JSON.stringify(new Materializer().materialize(partial)));
  });

  it('fils de commentaires : aller-retour, réactions clé par clé, JSON identique', () => {
    const message = (id: string, authorId: string, extra = {}) => ({ id, authorId, authorName: authorId, text: `Texte ${id}`, createdAt: '2026-10-05T10:00:00.000Z', ...extra });
    const source = {
      ...doc(10),
      comments: [
        {
          id: 'cm-1', anchor: { lng: 6.87, lat: 45.92, elevationM: 1035.5 }, createdBy: 'u-a', createdAt: '2026-10-05T10:00:00.000Z',
          zone: { ring: [[6.8, 45.9], [6.9, 45.9], [6.9, 46]] }, camera: { zoom: 13, pitch: 60, bearing: -20 },
          messages: [message('m-1', 'u-a', { reactions: { '👍~u-b': true, '❤️~u-a': true } }), message('m-2', 'u-b', { mentions: ['u-a'] })],
        },
        { id: 'cm-2', anchor: { lng: 6.9, lat: 45.95, elevationM: null }, createdBy: 'u-b', createdAt: 't', resolvedAt: 't2', resolvedBy: 'u-a', messages: [message('m-3', 'u-b')] },
      ],
    } as ProjectDocument;
    const store = build(source);
    expect(same(new Materializer().materialize(store), source)).toBe(true);
    expect(materializeJson(store)).toBe(JSON.stringify(new Materializer().materialize(store)));
    const messageObject = store.get(childObjectId(childObjectId('p', 'comments', 'cm-1'), 'messages', 'm-1'))!;
    expect([...messageObject.props.keys()].filter((key) => key.startsWith('reactions.'))).toHaveLength(2);
    // Dernier fil supprimé : le champ disparaît du document.
    const ops = change(store, source, { ...source, comments: undefined } as ProjectDocument);
    expect(ops.every((op) => op.t === 'd')).toBe(true);
    expect(new Materializer().materialize(store).comments).toBeUndefined();
  });

  it('même élément créé deux fois (deux éditeurs) : fusion des propriétés', () => {
    const store = build(doc(10));
    const id = childObjectId(itineraryObjectId('it-1'), 'timeline', 'poi-42');
    const parent = itineraryObjectId('it-1');
    applyOps(store, [{ t: 'c', id, parent, field: 'timeline', pos: 'a5', props: [['id', 'poi-42'], ['label', 'A']] }]);
    applyOps(store, [{ t: 'c', id, parent, field: 'timeline', pos: 'a5', props: [['id', 'poi-42'], ['favorite', true]] }]);
    const object = store.get(id)!;
    expect(object.props.get('label')).toBe('A');
    expect(object.props.get('favorite')).toBe(true);
  });
});
