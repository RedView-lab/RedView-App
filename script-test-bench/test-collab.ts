/**
 * Co-édition (src/features/collab) : modèle de fusion, codage Yjs, annuler par
 * utilisateur, auteur des calculs dérivés. Plusieurs répliques en mémoire
 * échangent leurs mises à jour Yjs (ordre et moment de livraison maîtrisés).
 * Sortie non nulle au premier échec.
 *
 *   npx tsx script-test-bench/test-collab.ts
 */
import * as Y from 'yjs';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';

import { canonicalJson } from '../src/features/itineraryPanel/lib/project/canonicalJson.ts';
import {
  composeProject,
  extractProjectLocalWork,
  extractProjectView,
  toProjectDocument,
  type ProjectDocument,
} from '../src/features/itineraryPanel/lib/project/layers.ts';
import { CollabComputeGate } from '../src/features/collab/computeGate.ts';
import { createCollabSession } from '../src/features/collab/session.ts';
import { broadcastChannelTransport } from '../src/features/collab/transports/broadcastChannel.ts';
import type { Itinerary, TimelineItem } from '../src/features/itineraryPanel/types/index.ts';
import { routeChunkBounds, ROUTE_CHUNK_MAX_POINTS, ROUTE_CHUNK_MIN_POINTS } from '../src/features/collab/routeChunks.ts';
import { ProjectDocBinding } from '../src/features/collab/yjs/binding.ts';
import { readDocument } from '../src/features/collab/yjs/codec.ts';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    failures += 1;
    process.exitCode = 1;
    return;
  }
  console.log(`✅ PASSED: ${message}`);
}

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

// ── Documents ───────────────────────────────────────────────────────────────

type RoutePoint = { lat: number; lon: number; distanceM: number; elevationM: number; surface?: string };

function makeRoute(count: number, offset = 0): RoutePoint[] {
  const points: RoutePoint[] = [];
  let lat = 45.9;
  let lon = 6.87;
  for (let i = 0; i < count; i += 1) {
    lat += 0.0002 + Math.sin((i + offset) / 50) * 0.0001;
    lon += 0.00015;
    points.push({ lat, lon, distanceM: i * 19.7, elevationM: 1000 + Math.sin(i / 300) * 400, surface: i % 7 ? 'asphalt' : 'gravel' });
  }
  return points;
}

function row(id: string, kind: TimelineItem['kind'], label: string, lat?: number, lon?: number): TimelineItem {
  return { id, kind, label, distanceKm: null, ...(lat !== undefined ? { lat, lon } : {}) };
}

function itinerary(id: string, name: string, routePoints: number): Itinerary {
  return {
    id,
    name,
    color: '#c50000',
    profileId: 'road',
    discipline: 'bike',
    priorities: { duration: 50, elevation: 50, distance: 50, tranquility: 50 },
    roadTypes: {
      road: 'prefer', gravel: 'tolerate', singletrack: 'avoid', offroad: 'avoid', bikeLanes: 'prefer',
      majorRoads: 'avoid', ferry: 'avoid', turns: 'tolerate', maxSlopePercent: 15, cities: 'tolerate',
      applyToAllItineraries: false,
    },
    rhythm: {
      startDate: null, startTime: '09:30', gender: 'default', practiceLevel: 'debutant',
      applyToAllItineraries: false, usePastActivities: false, ftp: null, systemWeightKg: null, tiresMm: 35,
      useWeather: false, weatherWeight: 100, useSurfaces: false, surfacesWeight: 100,
      pauseAtFavoritePois: false, poiPauseDurations: { fountains: 10 } as never,
      pauseEveryIntervalEnabled: false, pauseEveryIntervalMin: null,
      pauseIntervals: [{ id: 'pause-1', label: 'Pause 1', durationMin: 5, intervalMin: 60 }],
      pausePositionOverridesKm: {}, runReferenceMode: 'vma', vmaKmh: null, refRaceDistanceM: 10000,
      refRaceTimeS: null, runWeightKg: null, terrainTechnicality: 0.5,
    } as never,
    poi: { fountains: { enabled: true, distanceM: 20 }, toilets: { enabled: true, distanceM: 20 } } as never,
    timeline: [
      row('start', 'start', 'Chamonix', 45.92, 6.87),
      row('wp-a', 'waypoint', 'Col A', 45.95, 6.9),
      row('wp-b', 'waypoint', 'Col B', 45.98, 6.95),
      row('end', 'end', 'Annecy', 45.9, 6.12),
    ],
    forbiddenZones: [{ id: 'fz-1', points: [{ lat: 45, lon: 6 }, { lat: 45.1, lon: 6 }, { lat: 45, lon: 6.1 }], createdAt: '2026-10-01T00:00:00Z' }],
    fitUploads: [{ name: 'ride.fit', type: 'application/octet-stream', lastModified: 1, size: 10, path: 'u/ride.fit' }],
    gpxRoute: routePoints > 0
      ? { name: null, source: 'brouter', points: makeRoute(routePoints), routedInputsKey: 'stamp-0' }
      : undefined,
    prediction: { total_time_s: 3600, total_distance_m: 20000 } as never,
    poiFeatures: [{ id: 1, lat: 45.9, lon: 6.9, category: 'fountains', tags: {} }] as never,
  } as Itinerary;
}

function baseDocument(routePoints = 4000): ProjectDocument {
  return {
    schema: 2,
    name: 'Tour du Mont-Blanc',
    savedAt: null,
    sizeBytes: null,
    privacy: 'private',
    itineraries: [itinerary('it-1', 'Principal', routePoints), itinerary('it-2', 'Variante', 600)],
  };
}

// ── Opérations (documents immuables, comme le ProjectStore) ──────────────────

function mapItinerary(doc: ProjectDocument, id: string, fn: (it: Itinerary) => Itinerary): ProjectDocument {
  return { ...doc, itineraries: doc.itineraries.map((it) => (it.id === id ? (fn(it as Itinerary) as typeof it) : it)) };
}
const getItinerary = (doc: ProjectDocument, id: string) => doc.itineraries.find((it) => it.id === id) as Itinerary | undefined;

// ── Répliques et réseau ──────────────────────────────────────────────────────

const NET = Symbol('net');

interface Replica {
  name: string;
  binding: ProjectDocBinding;
  inbox: Uint8Array[];
  externalCauses: string[];
  sentBytes: number;
}

function createReplicas(names: string[], options: { captureTimeoutMs?: number } = {}): Replica[] {
  const replicas: Replica[] = names.map((name) => ({
    name,
    binding: new ProjectDocBinding({ captureTimeoutMs: options.captureTimeoutMs ?? 0 }),
    inbox: [],
    externalCauses: [],
    sentBytes: 0,
  }));
  for (const replica of replicas) {
    replica.binding.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === NET) return;
      replica.sentBytes += update.byteLength;
      for (const peer of replicas) if (peer !== replica) peer.inbox.push(update);
    });
    replica.binding.onExternalChange((_doc, cause) => replica.externalCauses.push(cause));
  }
  return replicas;
}

/** Livre les mises à jour en attente (ordre aléatoire si `shuffle`). */
function deliver(replica: Replica, shuffle = false): void {
  const updates = replica.inbox.splice(0);
  if (shuffle) updates.sort(() => rnd() - 0.5);
  for (const update of updates) Y.applyUpdate(replica.binding.ydoc, update, NET);
  if (!replica.binding.ready) replica.binding.adoptRemoteState();
}

function syncAll(replicas: Replica[], shuffle = false): void {
  for (let round = 0; round < 10 && replicas.some((r) => r.inbox.length > 0); round += 1) {
    for (const replica of replicas) deliver(replica, shuffle);
  }
}

/** Une réplique semée, les autres reçoivent son état (comme d'un serveur). */
function startSession(names: string[], document: ProjectDocument, options: { captureTimeoutMs?: number } = {}): Replica[] {
  const replicas = createReplicas(names, options);
  replicas[0].binding.seed(document);
  const state = Y.encodeStateAsUpdate(replicas[0].binding.ydoc);
  for (const replica of replicas.slice(1)) {
    Y.applyUpdate(replica.binding.ydoc, state, NET);
    replica.binding.adoptRemoteState();
  }
  for (const replica of replicas) replica.inbox.length = 0;
  return replicas;
}

const edit = (replica: Replica, fn: (doc: ProjectDocument) => ProjectDocument, change: 'user' | 'step' | 'background' = 'user') =>
  replica.binding.applyLocal(fn(replica.binding.getDocument()), change);

function converged(replicas: Replica[]): boolean {
  const reference = canonicalJson(replicas[0].binding.getDocument());
  return replicas.every((r) => canonicalJson(r.binding.getDocument()) === reference);
}

// ── 1. Aller-retour ──────────────────────────────────────────────────────────
{
  const document = baseDocument();
  const [a, b] = startSession(['A', 'B'], document);
  assert(same(a.binding.getDocument(), document), 'semis : le document relu est identique');
  assert(same(b.binding.getDocument(), document), 'état reçu par un 2e éditeur : identique');
  assert(same(readDocument(b.binding.ydoc), document), 'lecture à froid du Y.Doc : identique');
  const withUndefined = mapItinerary(document, 'it-2', (it) => ({ ...it, prediction: undefined, metrics: { distanceKm: 12, durationSec: undefined } }));
  edit(a, () => withUndefined);
  syncAll([a, b]);
  assert(same(b.binding.getDocument(), withUndefined), 'valeurs absentes / undefined : même document des deux côtés');
}

// ── 2. Semis déterministe ───────────────────────────────────────────────────
{
  const document = baseDocument(1500);
  const [a, b] = createReplicas(['A', 'B']);
  a.binding.seed(document);
  b.binding.seed(JSON.parse(JSON.stringify(document)) as ProjectDocument);
  a.inbox.length = 0;
  b.inbox.length = 0;
  Y.applyUpdate(b.binding.ydoc, Y.encodeStateAsUpdate(a.binding.ydoc), NET);
  Y.applyUpdate(a.binding.ydoc, Y.encodeStateAsUpdate(b.binding.ydoc), NET);
  assert(converged([a, b]) && same(a.binding.getDocument(), document), 'deux semis du même document : aucun doublon');
  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, timeline: it.timeline.filter((r) => r.id !== 'wp-a') })));
  syncAll([a, b]);
  assert(
    !getItinerary(b.binding.getDocument(), 'it-1')!.timeline.some((r) => r.id === 'wp-a'),
    'suppression après deux semis : la ligne ne réapparaît pas',
  );
}

// ── 3. Éditions concurrentes ────────────────────────────────────────────────
{
  const [a, b] = startSession(['A', 'B'], baseDocument());
  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, name: 'Nom de A' })));
  edit(b, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, color: '#3d8bff' })));
  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, priorities: { ...it.priorities, elevation: 90 } })));
  edit(b, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, priorities: { ...it.priorities, tranquility: 10 } })));
  syncAll([a, b]);
  const it = getItinerary(a.binding.getDocument(), 'it-1')!;
  assert(converged([a, b]), 'éditions concurrentes : convergence');
  assert(it.name === 'Nom de A' && it.color === '#3d8bff', 'champs différents du même itinéraire : les deux gardés');
  assert(it.priorities.elevation === 90 && it.priorities.tranquility === 10, 'réglages différents d’un même objet : fusion clé par clé');

  edit(a, (doc) => mapItinerary(doc, 'it-1', (iti) => ({ ...iti, name: 'X' })));
  edit(b, (doc) => mapItinerary(doc, 'it-1', (iti) => ({ ...iti, name: 'Y' })));
  syncAll([a, b], true);
  const name = getItinerary(a.binding.getDocument(), 'it-1')!.name;
  assert(converged([a, b]) && (name === 'X' || name === 'Y'), `même champ en même temps : une seule valeur partout (${name})`);
}

// ── 4. Listes : ajouts, déplacements, suppressions ──────────────────────────
{
  const [a, b] = startSession(['A', 'B'], baseDocument(0));
  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => ({
    ...it, timeline: [it.timeline[0], row('wp-from-a', 'waypoint', 'A', 46, 7), ...it.timeline.slice(1)],
  })));
  edit(b, (doc) => mapItinerary(doc, 'it-1', (it) => ({
    ...it, timeline: [...it.timeline.slice(0, -1), row('wp-from-b', 'waypoint', 'B', 46.1, 7.1), it.timeline[it.timeline.length - 1]],
  })));
  syncAll([a, b], true);
  const ids = getItinerary(a.binding.getDocument(), 'it-1')!.timeline.map((r) => r.id);
  assert(converged([a, b]), 'ajouts concurrents dans la feuille de route : convergence');
  assert(
    ids.join() === 'start,wp-from-a,wp-a,wp-b,wp-from-b,end',
    `ajouts concurrents : les deux lignes, à leur place (${ids.join()})`,
  );

  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => {
    const moved = it.timeline.find((r) => r.id === 'wp-a')!;
    const rest = it.timeline.filter((r) => r.id !== 'wp-a');
    return { ...it, timeline: [...rest.slice(0, -1), moved, rest[rest.length - 1]] };
  }));
  edit(b, (doc) => mapItinerary(doc, 'it-1', (it) => ({
    ...it, timeline: it.timeline.map((r) => (r.id === 'wp-a' ? { ...r, label: 'Col A renommé', lat: 45.951 } : r)),
  })));
  syncAll([a, b], true);
  const moved = getItinerary(b.binding.getDocument(), 'it-1')!.timeline;
  const wpA = moved.find((r) => r.id === 'wp-a')!;
  assert(converged([a, b]), 'déplacement + édition concurrents : convergence');
  assert(
    moved[moved.length - 2].id === 'wp-a' && wpA.label === 'Col A renommé' && wpA.lat === 45.951,
    'ligne déplacée par A et modifiée par B : déplacée ET modifiée',
  );

  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => {
    const r1 = it.timeline.find((r) => r.id === 'wp-b')!;
    const rest = it.timeline.filter((r) => r.id !== 'wp-b');
    return { ...it, timeline: [rest[0], r1, ...rest.slice(1)] };
  }));
  edit(b, (doc) => mapItinerary(doc, 'it-1', (it) => {
    const r1 = it.timeline.find((r) => r.id === 'wp-b')!;
    const rest = it.timeline.filter((r) => r.id !== 'wp-b');
    return { ...it, timeline: [...rest.slice(0, -1), r1, rest[rest.length - 1]] };
  }));
  syncAll([a, b], true);
  const twice = getItinerary(a.binding.getDocument(), 'it-1')!.timeline.map((r) => r.id);
  assert(
    converged([a, b]) && twice.filter((id) => id === 'wp-b').length === 1,
    `même ligne déplacée par les deux : une seule fois (${twice.join()})`,
  );

  edit(a, (doc) => ({ ...doc, itineraries: doc.itineraries.filter((it) => it.id !== 'it-2') }));
  edit(b, (doc) => mapItinerary(doc, 'it-2', (it) => ({ ...it, name: 'Variante modifiée' })));
  syncAll([a, b], true);
  assert(
    converged([a, b]) && !getItinerary(a.binding.getDocument(), 'it-2'),
    'itinéraire supprimé par A pendant que B le modifie : supprimé partout',
  );

  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => ({
    ...it, rhythm: { ...it.rhythm, pauseIntervals: [...it.rhythm.pauseIntervals, { id: 'pause-a', label: 'A', durationMin: 10, intervalMin: 90 }] },
  })));
  edit(b, (doc) => mapItinerary(doc, 'it-1', (it) => ({
    ...it, rhythm: { ...it.rhythm, startTime: '06:00', pauseIntervals: [...it.rhythm.pauseIntervals, { id: 'pause-b', label: 'B', durationMin: 20, intervalMin: 120 }] },
  })));
  syncAll([a, b], true);
  const rhythm = getItinerary(a.binding.getDocument(), 'it-1')!.rhythm;
  assert(
    converged([a, b]) && rhythm.startTime === '06:00' && rhythm.pauseIntervals.length === 3,
    'rythme : pauses ajoutées par chacun + heure de départ, tout est gardé',
  );
}

// ── 5. Tracé en segments ────────────────────────────────────────────────────
{
  const points = makeRoute(100_000);
  const bounds = routeChunkBounds(points);
  const sizes = bounds.map((end, i) => end - (i ? bounds[i - 1] : 0));
  assert(
    sizes.slice(0, -1).every((size) => size >= ROUTE_CHUNK_MIN_POINTS && size <= ROUTE_CHUNK_MAX_POINTS),
    `découpage : ${bounds.length} segments de ${Math.min(...sizes)} à ${Math.max(...sizes)} points`,
  );

  const document = baseDocument(0);
  const withRoute = mapItinerary(document, 'it-1', (it) => ({ ...it, gpxRoute: { name: null, source: 'brouter', points, routedInputsKey: 'k1' } }));
  const [a, b] = startSession(['A', 'B'], withRoute);
  const fullJson = JSON.stringify(points).length;
  a.sentBytes = 0;
  // Édition locale : une fenêtre de ~400 points remplacée au milieu (patch BRouter).
  const t0 = performance.now();
  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => {
    const patched = [...it.gpxRoute!.points];
    const replacement = makeRoute(420, 999).map((p, i) => ({ ...p, lat: p.lat + 0.01, distanceM: 50_000 * 19.7 + i }));
    patched.splice(50_000, 400, ...replacement);
    return { ...it, gpxRoute: { ...it.gpxRoute!, points: patched, routedInputsKey: 'k2' } };
  }), 'background');
  const writeMs = performance.now() - t0;
  syncAll([a, b]);
  const routeB = getItinerary(b.binding.getDocument(), 'it-1')!.gpxRoute!;
  assert(
    same(routeB, getItinerary(a.binding.getDocument(), 'it-1')!.gpxRoute),
    'tracé de 100 000 points modifié par A : identique chez B',
  );
  assert(
    a.sentBytes < fullJson * 0.03,
    `fenêtre de 400 points modifiée : ${(a.sentBytes / 1024).toFixed(0)} Ko envoyés pour un tracé de ${(fullJson / 1e6).toFixed(1)} Mo (< 3 %)`,
  );
  assert(writeMs < 400, `écriture locale du tracé modifié : ${writeMs.toFixed(0)} ms`);

  const before = b.binding.getDocument();
  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, name: 'Renommé' })));
  syncAll([a, b]);
  const after = b.binding.getDocument();
  assert(
    getItinerary(after, 'it-1')!.gpxRoute!.points === getItinerary(before, 'it-1')!.gpxRoute!.points,
    'renommage distant : les points du tracé gardent leur référence (pas de recalcul d’affichage)',
  );
  assert(getItinerary(after, 'it-2') === getItinerary(before, 'it-2'), 'itinéraire non touché : même objet');
}

// ── 6. Annuler propre à chaque utilisateur ──────────────────────────────────
{
  const [a, b] = startSession(['A', 'B'], baseDocument(2000), { captureTimeoutMs: 0 });
  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, name: 'Nom de A' })), 'step');
  syncAll([a, b]);
  edit(b, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, color: '#9b59ff' })), 'step');
  syncAll([a, b]);
  assert(a.binding.canUndo() && b.binding.canUndo(), 'chacun a sa propre étape à annuler');
  a.binding.undo();
  syncAll([a, b]);
  const it = getItinerary(b.binding.getDocument(), 'it-1')!;
  assert(converged([a, b]) && it.name === 'Principal' && it.color === '#9b59ff', 'A annule : son renommage seul, la couleur de B reste');
  assert(a.externalCauses.includes('undo'), 'annuler arrive au store comme « undo »');
  a.binding.redo();
  syncAll([a, b]);
  assert(getItinerary(b.binding.getDocument(), 'it-1')!.name === 'Nom de A', 'A rétablit : renommage revenu chez B');

  // Déplacement de point (A) puis tracé calculé en arrière-plan : une seule étape.
  const stampBefore = getItinerary(a.binding.getDocument(), 'it-1')!.gpxRoute!.routedInputsKey;
  const pointsBefore = getItinerary(a.binding.getDocument(), 'it-1')!.gpxRoute!.points;
  edit(a, (doc) => mapItinerary(doc, 'it-1', (iti) => ({
    ...iti, timeline: iti.timeline.map((r) => (r.id === 'wp-b' ? { ...r, lat: 46.2, lon: 7.2 } : r)),
  })), 'step');
  edit(b, (doc) => mapItinerary(doc, 'it-2', (iti) => ({ ...iti, name: 'B travaille ailleurs' })), 'step');
  syncAll([a, b]);
  edit(a, (doc) => mapItinerary(doc, 'it-1', (iti) => ({
    ...iti, gpxRoute: { ...iti.gpxRoute!, points: makeRoute(2100, 5), routedInputsKey: 'stamp-moved' },
  })), 'background');
  syncAll([a, b]);
  a.binding.undo();
  syncAll([a, b]);
  const undone = getItinerary(b.binding.getDocument(), 'it-1')!;
  assert(
    undone.timeline.find((r) => r.id === 'wp-b')!.lat === 45.98
      && undone.gpxRoute!.routedInputsKey === stampBefore
      && same(undone.gpxRoute!.points, pointsBefore),
    'annuler un déplacement : point ET tracé d’avant reviennent, sans nouveau routage',
  );
  assert(getItinerary(b.binding.getDocument(), 'it-2')!.name === 'B travaille ailleurs', '… sans toucher au travail de B');
  a.binding.redo();
  syncAll([a, b]);
  const redone = getItinerary(b.binding.getDocument(), 'it-1')!;
  assert(redone.gpxRoute!.routedInputsKey === 'stamp-moved' && redone.timeline.find((r) => r.id === 'wp-b')!.lat === 46.2, 'rétablir : point et nouveau tracé');

  edit(b, (doc) => mapItinerary(doc, 'it-1', (iti) => ({ ...iti, gpxRoute: { ...iti.gpxRoute!, routedInputsKey: 'b-background' } })), 'background');
  const bStack = b.binding.undoManager.undoStack.length;
  assert(bStack === 2, 'résultat d’arrière-plan sur un itinéraire que B n’a pas édité : pas d’étape ajoutée');
}

// ── 7. Auteur des calculs dérivés ───────────────────────────────────────────
{
  let clock = 1000;
  const replicas = createReplicas(['A', 'B']).map((r) => r);
  const [a, b] = replicas;
  // Horloges maîtrisées.
  (a.binding as unknown as { now: () => number }).now = () => clock;
  (b.binding as unknown as { now: () => number }).now = () => clock;
  a.binding.seed(baseDocument(500));
  Y.applyUpdate(b.binding.ydoc, Y.encodeStateAsUpdate(a.binding.ydoc), NET);
  b.binding.adoptRemoteState();
  a.inbox.length = 0;
  b.inbox.length = 0;
  assert(a.binding.lastInputChange('route', 'it-1') === undefined, 'à l’ouverture : aucun auteur');
  clock = 2000;
  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, timeline: it.timeline.map((r) => (r.id === 'wp-a' ? { ...r, lat: 45.96 } : r)) })));
  syncAll([a, b]);
  assert(a.binding.lastInputChange('route', 'it-1')?.local === true, 'A déplace un point : A est l’auteur du tracé');
  assert(b.binding.lastInputChange('route', 'it-1')?.local === false, '… B le sait (modification distante)');
  assert(b.binding.lastInputChange('prediction', 'it-1') === undefined, '… la prédiction n’est pas encore concernée');
  clock = 3000;
  edit(a, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, gpxRoute: { ...it.gpxRoute!, routedInputsKey: 'new' } })), 'background');
  syncAll([a, b]);
  assert(
    a.binding.lastInputChange('prediction', 'it-1')?.local === true && b.binding.lastInputChange('prediction', 'it-1')?.local === false,
    'tracé recalculé par A : A est aussi l’auteur de la prédiction',
  );
  clock = 4000;
  edit(b, (doc) => mapItinerary(doc, 'it-1', (it) => ({ ...it, rhythm: { ...it.rhythm, startTime: '05:00' } })));
  syncAll([a, b]);
  assert(
    b.binding.lastInputChange('prediction', 'it-1')?.local === true && b.binding.lastInputChange('route', 'it-1')?.local === false,
    'B change le rythme : B devient l’auteur de la prédiction, pas du tracé',
  );
}

// ── 8. Fuzz : 3 éditeurs, livraisons partielles dans le désordre ─────────────
{
  const replicas = startSession(['A', 'B', 'C'], baseDocument(3000));
  const ops: Array<(doc: ProjectDocument) => ProjectDocument> = [
    (doc) => mapItinerary(doc, pick(doc.itineraries).id, (it) => ({ ...it, name: `n${Math.floor(rnd() * 1000)}` })),
    (doc) => mapItinerary(doc, pick(doc.itineraries).id, (it) => ({ ...it, color: pick(['#c50000', '#3d8bff', '#5ab95a']) })),
    (doc) => mapItinerary(doc, pick(doc.itineraries).id, (it) => {
      const index = 1 + Math.floor(rnd() * Math.max(1, it.timeline.length - 1));
      const timeline = [...it.timeline];
      timeline.splice(index, 0, row(`wp-${Math.floor(rnd() * 1e9)}`, 'waypoint', 'fuzz', 45 + rnd(), 6 + rnd()));
      return { ...it, timeline };
    }),
    (doc) => mapItinerary(doc, pick(doc.itineraries).id, (it) => {
      const removable = it.timeline.filter((r) => r.kind === 'waypoint');
      if (removable.length === 0) return it;
      const target = pick(removable).id;
      return { ...it, timeline: it.timeline.filter((r) => r.id !== target) };
    }),
    (doc) => mapItinerary(doc, pick(doc.itineraries).id, (it) => {
      if (it.timeline.length < 3) return it;
      const timeline = [...it.timeline];
      const [moved] = timeline.splice(1 + Math.floor(rnd() * (timeline.length - 2)), 1);
      timeline.splice(1 + Math.floor(rnd() * (timeline.length - 1)), 0, moved);
      return { ...it, timeline };
    }),
    (doc) => mapItinerary(doc, pick(doc.itineraries).id, (it) => ({
      ...it, timeline: it.timeline.map((r) => (rnd() < 0.3 ? { ...r, label: `l${Math.floor(rnd() * 99)}` } : r)),
    })),
    (doc) => mapItinerary(doc, pick(doc.itineraries).id, (it) => ({ ...it, priorities: { ...it.priorities, distance: Math.floor(rnd() * 100) } })),
    (doc) => mapItinerary(doc, pick(doc.itineraries).id, (it) => {
      if (!it.gpxRoute) return { ...it, gpxRoute: { name: null, source: 'brouter', points: makeRoute(800, Math.floor(rnd() * 99)) } };
      const points = [...it.gpxRoute.points];
      const at = Math.floor(rnd() * Math.max(1, points.length - 200));
      points.splice(at, Math.floor(rnd() * 150), ...makeRoute(Math.floor(rnd() * 200), Math.floor(rnd() * 999)));
      return { ...it, gpxRoute: { ...it.gpxRoute, points, routedInputsKey: `r${Math.floor(rnd() * 1e6)}` } };
    }),
    (doc) => (doc.itineraries.length > 1 && rnd() < 0.3
      ? { ...doc, itineraries: doc.itineraries.filter((it) => it.id !== pick(doc.itineraries).id) }
      : { ...doc, itineraries: [...doc.itineraries, itinerary(`it-${Math.floor(rnd() * 1e9)}`, 'nouveau', 0)] }),
    (doc) => ({ ...doc, name: `projet ${Math.floor(rnd() * 100)}` }),
  ];
  const addItinerary = (doc: ProjectDocument): ProjectDocument => ({
    ...doc, itineraries: [...doc.itineraries, itinerary(`it-${Math.floor(rnd() * 1e9)}`, 'nouveau', 0)],
  });
  for (let step = 0; step < 600; step += 1) {
    const replica = pick(replicas);
    const op = replica.binding.getDocument().itineraries.length === 0 ? addItinerary : pick(ops);
    edit(replica, op, pick(['user', 'step', 'background'] as const));
    if (rnd() < 0.25) deliver(pick(replicas), true);
    if (rnd() < 0.03) {
      const undoer = pick(replicas);
      if (rnd() < 0.5) undoer.binding.undo(); else undoer.binding.redo();
    }
  }
  syncAll(replicas, true);
  assert(converged(replicas), 'fuzz (600 opérations, 3 éditeurs, livraisons partielles et désordonnées, annuler) : convergence');
  const doc = replicas[0].binding.getDocument();
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  assert(
    unique(doc.itineraries.map((it) => it.id))
      && doc.itineraries.every((it) => unique((it as Itinerary).timeline.map((r) => r.id))),
    'fuzz : aucun id en double (itinéraires, lignes)',
  );
  assert(
    doc.itineraries.every((it) => !(it as Itinerary).gpxRoute || Array.isArray((it as Itinerary).gpxRoute!.points)),
    'fuzz : tous les tracés se relisent',
  );
}

// ── 9. Qui calcule : auteur, calcul annoncé, délai, désignation ─────────────
{
  let clock = 10_000;
  const now = () => clock;
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const bindingA = new ProjectDocBinding({ ydoc: docA, captureTimeoutMs: 0, now });
  const bindingB = new ProjectDocBinding({ ydoc: docB, captureTimeoutMs: 0, now });
  const awarenessA = new Awareness(docA);
  const awarenessB = new Awareness(docB);
  awarenessA.setLocalState({ computing: {} });
  awarenessB.setLocalState({ computing: {} });
  const relay = (from: Awareness, to: Awareness) => applyAwarenessUpdate(to, encodeAwarenessUpdate(from, [...from.getStates().keys()]), 'net');
  awarenessA.on('update', () => relay(awarenessA, awarenessB));
  awarenessB.on('update', () => relay(awarenessB, awarenessA));
  relay(awarenessA, awarenessB);
  relay(awarenessB, awarenessA);
  docA.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== NET) Y.applyUpdate(docB, update, NET); });
  docB.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== NET) Y.applyUpdate(docA, update, NET); });
  bindingA.seed(baseDocument(300));
  bindingB.adoptRemoteState();
  const gateA = new CollabComputeGate(bindingA, awarenessA, { graceMs: 5000, now });
  const gateB = new CollabComputeGate(bindingB, awarenessB, { graceMs: 5000, now });
  const elected = docA.clientID < docB.clientID ? 'A' : 'B';
  const gateOf = { A: gateA, B: gateB };

  assert(
    gateOf[elected].shouldCompute('route', 'it-1') && !gateOf[elected === 'A' ? 'B' : 'A'].shouldCompute('route', 'it-1'),
    `tracé périmé à l'ouverture, sans auteur : un seul éditeur désigné (${elected})`,
  );
  let notified = 0;
  gateB.subscribe(() => { notified += 1; });
  clock = 20_000;
  bindingA.applyLocal(mapItinerary(bindingA.getDocument(), 'it-1', (it) => ({
    ...it, timeline: it.timeline.map((r) => (r.id === 'wp-a' ? { ...r, lat: 45.97 } : r)),
  })), 'step');
  assert(gateA.shouldCompute('route', 'it-1'), 'A déplace un point : A route');
  assert(!gateB.shouldCompute('route', 'it-1'), '… B attend (modification distante récente)');
  const release = gateA.beginCompute('route', 'it-1');
  clock = 40_000;
  assert(!gateB.shouldCompute('route', 'it-1'), '… B attend tant que A annonce le calcul (même après le délai)');
  const notifiedBefore = notified;
  release();
  assert(notified > notifiedBefore, 'fin du calcul annoncée : B est prévenu');
  assert(
    gateB.shouldCompute('route', 'it-1') === (elected === 'B'),
    'A n’a pas livré : après le délai, l’éditeur désigné prend le relais',
  );
  assert(
    gateA.shouldCompute('prediction', 'it-1') === (elected === 'A'),
    'prédiction dont personne n’a modifié les entrées : seul l’éditeur désigné la calcule',
  );
  gateA.destroy();
  gateB.destroy();
  awarenessA.destroy();
  awarenessB.destroy();
  bindingA.destroy();
  bindingB.destroy();
}

// ── 10. Session complète sur BroadcastChannel (comme deux onglets) ──────────
{
  const document = baseDocument(1200);
  const channel = `rv-test-${Date.now()}`;
  const first = createCollabSession({ getSeedDocument: () => document, transport: broadcastChannelTransport(channel, { syncTimeoutMs: 150 }) });
  await first.ready;
  const second = createCollabSession({
    getSeedDocument: () => baseDocument(10),
    transport: broadcastChannelTransport(channel, { syncTimeoutMs: 1500 }),
  });
  await second.ready;
  assert(same(second.link.getDocument(), document), '2e onglet : reçoit le document du 1er (pas son propre semis)');
  const received: string[] = [];
  second.link.subscribe((_doc, cause) => received.push(cause));
  first.link.pushLocalDocument(mapItinerary(first.link.getDocument(), 'it-1', (it) => ({ ...it, name: 'Depuis l’onglet 1' })), 'step');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(
    getItinerary(second.link.getDocument(), 'it-1')!.name === 'Depuis l’onglet 1' && received.includes('remote'),
    'modification de l’onglet 1 reçue par l’onglet 2 (« remote »)',
  );
  assert(second.awareness.getStates().size === 2, 'présence : chaque onglet voit les deux éditeurs');
  first.destroy();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(second.awareness.getStates().size === 1, 'onglet fermé : il quitte la présence');
  second.destroy();
}

// ── 11. Document distant recomposé avec la vue et le travail local ──────────
{
  const local = composeProject(baseDocument(200), null, null);
  const withViewAndWork: typeof local = {
    ...local,
    activeItineraryId: 'it-2',
    activeMode: 'poi',
    itineraries: local.itineraries.map((it) => (it.id === 'it-1'
      ? { ...it, opacity: 40, pendingRoutePatch: { start: { lat: 1, lon: 1, kind: 'start' as const }, end: { lat: 2, lon: 2, kind: 'end' as const }, via: [] } }
      : it)),
  };
  const remote = mapItinerary(toProjectDocument(withViewAndWork), 'it-1', (it) => ({ ...it, name: 'Renommé ailleurs' }));
  const next = composeProject(remote, extractProjectView(withViewAndWork), extractProjectLocalWork(withViewAndWork));
  const it1 = next.itineraries.find((it) => it.id === 'it-1')!;
  assert(
    it1.name === 'Renommé ailleurs' && it1.opacity === 40 && !!it1.pendingRoutePatch && next.activeMode === 'poi' && next.activeItineraryId === 'it-2',
    'modification distante appliquée : vue (opacité, mode, itinéraire actif) et édition en attente de cet appareil gardées',
  );
}

// ── 12. Fuzz sur d'autres graines ───────────────────────────────────────────
for (const fuzzSeed of [7, 1234, 2026, 99_991]) {
  seed = fuzzSeed;
  const replicas = startSession(['A', 'B', 'C'], baseDocument(1500));
  for (let step = 0; step < 400; step += 1) {
    const replica = pick(replicas);
    const doc = replica.binding.getDocument();
    const next = doc.itineraries.length === 0
      ? { ...doc, itineraries: [itinerary(`it-${Math.floor(rnd() * 1e9)}`, 'nouveau', 0)] }
      : mapItinerary(doc, pick(doc.itineraries).id, (it) => {
          const roll = rnd();
          if (roll < 0.3) return { ...it, name: `n${Math.floor(rnd() * 999)}` };
          if (roll < 0.6) {
            const timeline = [...it.timeline];
            if (rnd() < 0.5 && timeline.length > 2) timeline.splice(1 + Math.floor(rnd() * (timeline.length - 2)), 1);
            else timeline.splice(1, 0, row(`wp-${Math.floor(rnd() * 1e9)}`, 'waypoint', 'f', 45 + rnd(), 6 + rnd()));
            return { ...it, timeline };
          }
          if (roll < 0.85 && it.gpxRoute) {
            const points = [...it.gpxRoute.points];
            points.splice(Math.floor(rnd() * points.length), Math.floor(rnd() * 80), ...makeRoute(Math.floor(rnd() * 90), Math.floor(rnd() * 999)));
            return { ...it, gpxRoute: { ...it.gpxRoute, points } };
          }
          return { ...it, rhythm: { ...it.rhythm, tiresMm: 25 + Math.floor(rnd() * 30) } };
        });
    replica.binding.applyLocal(next, pick(['user', 'step', 'background'] as const));
    if (rnd() < 0.3) deliver(pick(replicas), true);
    if (rnd() < 0.05) {
      const undoer = pick(replicas);
      if (rnd() < 0.6) undoer.binding.undo(); else undoer.binding.redo();
    }
  }
  syncAll(replicas, true);
  assert(converged(replicas), `fuzz (graine ${fuzzSeed}, 400 opérations) : convergence`);
}

if (failures > 0) console.error(`\n${failures} échec(s)`);
else console.log('\nCo-édition : tout est conforme.');
