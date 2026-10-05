import { applyCommentAction, COMMENT_REACTIONS, type CommentAction } from '@/features/comments/lib/commentActions';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';
import type { Itinerary, ProjectCommentThread } from '@/features/itineraryPanel/types';

/**
 * Documents de test et modifications aléatoires « comme dans l'application »
 * (documents immuables : seules les parties modifiées sont recréées).
 */

export type RoutePoint = { lat: number; lon: number; distanceM: number; elevationM: number };

export function routePoints(count: number, seed = 0): RoutePoint[] {
  return Array.from({ length: count }, (_, index) => ({
    lat: Math.round((45.9 + index * 0.0002 + seed * 0.01) * 1e6) / 1e6,
    lon: Math.round((6.87 + index * 0.00015) * 1e6) / 1e6,
    distanceM: Math.round(index * 19.7 * 10) / 10,
    elevationM: Math.round((1000 + Math.sin((index + seed) / 30) * 300) * 10) / 10,
  }));
}

function sampleItinerary(id: string, name: string, points = 0): Itinerary {
  return {
    id,
    name,
    color: '#c50000',
    profileId: 'road',
    priorities: { duration: 50, elevation: 50, distance: 50, tranquility: 50 },
    roadTypes: { road: 'prefer', gravel: 'avoid', applyToAllItineraries: false },
    rhythm: {
      startTime: '09:30',
      pauseIntervals: [{ id: 'pause-1', label: 'Pause 1', durationMin: 5, intervalMin: 60 }],
      pausePositionOverridesKm: {},
      poiPauseDurations: { fountains: 10, toilets: null },
    },
    poi: { fountains: { enabled: true, distanceM: 20 } },
    timeline: [
      { id: 'start', kind: 'start', label: 'Chamonix', distanceKm: 0, lat: 45.92, lon: 6.87 },
      { id: 'wp-a', kind: 'waypoint', label: 'Col A', distanceKm: 12, lat: 45.95, lon: 6.9 },
      { id: 'wp-b', kind: 'waypoint', label: 'Col B', distanceKm: 30, lat: 45.98, lon: 6.95 },
      { id: 'end', kind: 'end', label: 'Annecy', distanceKm: null, lat: 45.9, lon: 6.12 },
    ],
    forbiddenZones: [],
    steepAlertOverrides: {},
    fitUploads: [],
    ...(points > 0 ? { gpxRoute: { name: null, source: 'brouter', points: routePoints(points), routedInputsKey: 'k0' } } : {}),
  } as unknown as Itinerary;
}

/**
 * Itinéraire réservé aux compteurs du simulateur, toujours premier : aucune
 * modification aléatoire ne le touche (ni le déplace), donc aucune étape
 * d'annulation ne l'inclut et ses compteurs ne sont jamais annulés.
 */
const COUNTERS_ITINERARY_ID = 'it-counters';

export function sampleDocument(routeSize = 1_500): ProjectDocument {
  return {
    schema: 2,
    name: 'Tour du Mont-Blanc',
    savedAt: null,
    sizeBytes: null,
    privacy: 'private',
    itineraries: [
      sampleItinerary(COUNTERS_ITINERARY_ID, 'Compteurs'),
      sampleItinerary('it-1', 'Principal', routeSize),
      sampleItinerary('it-2', 'Variante', Math.floor(routeSize / 3)),
    ],
  } as unknown as ProjectDocument;
}

type Random = () => number;
type Edit = { document: ProjectDocument; change: 'user' | 'step' | 'background' | 'comment' } | null;

const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)];

function itineraries(document: ProjectDocument): Itinerary[] {
  return document.itineraries as unknown as Itinerary[];
}

function editable(document: ProjectDocument): Itinerary[] {
  return itineraries(document).filter((itinerary) => itinerary.id !== COUNTERS_ITINERARY_ID);
}

function withItinerary(document: ProjectDocument, id: string, update: (itinerary: Itinerary) => Itinerary): ProjectDocument {
  return {
    ...document,
    itineraries: itineraries(document).map((itinerary) => (itinerary.id === id ? update(itinerary) : itinerary)),
  } as ProjectDocument;
}

/** Incrémente le compteur propre à `clientId` (seul lui l'écrit : sa valeur finale doit être la dernière écrite). */
export function incrementCounter(document: ProjectDocument, clientId: string): { document: ProjectDocument; value: number } {
  const counters = itineraries(document).find((itinerary) => itinerary.id === COUNTERS_ITINERARY_ID)!;
  const overrides = (counters.steepAlertOverrides ?? {}) as Record<string, { count: number }>;
  const value = (overrides[clientId]?.count ?? 0) + 1;
  return {
    value,
    document: withItinerary(document, COUNTERS_ITINERARY_ID, (itinerary) => ({
      ...itinerary,
      steepAlertOverrides: { ...overrides, [clientId]: { count: value } },
    } as unknown as Itinerary)),
  };
}

export function readCounter(document: ProjectDocument, clientId: string): number {
  const counters = itineraries(document).find((itinerary) => itinerary.id === COUNTERS_ITINERARY_ID);
  return ((counters?.steepAlertOverrides ?? {}) as Record<string, { count?: number }>)[clientId]?.count ?? 0;
}

/** Auteur des commentaires d'un client du simulateur (son utilisateur côté serveur). */
export function simUserId(clientId: string): string {
  return `user-${clientId}`;
}

/**
 * Action de commentaire au hasard, par le réducteur de l'app (mêmes droits que
 * le serveur : aucune ne doit être refusée, sinon le lot entier — et le
 * compteur qu'il porte peut-être — serait perdu).
 */
function randomCommentEdit(document: ProjectDocument, random: Random, clientId: string, n: number): Edit {
  const me = { userId: simUserId(clientId), name: clientId };
  const threads: readonly ProjectCommentThread[] = document.comments ?? [];
  const at = new Date(Date.UTC(2026, 9, 5, 10, 0, n % 3_600)).toISOString();
  const roll = random();
  let action: CommentAction;
  if (threads.length === 0 || roll < 0.25) {
    const lng = 6.8 + random() * 0.2;
    const lat = 45.8 + random() * 0.2;
    action = {
      type: 'create-thread', threadId: `cm-${clientId}-${n}`, messageId: `msg-${clientId}-${n}`,
      anchor: { lng, lat, elevationM: 1000 + n }, text: `Fil ${clientId} ${n}`, at,
      ...(random() < 0.3 ? { zone: { ring: [[lng, lat], [lng + 0.01, lat], [lng + 0.01, lat + 0.01]] as Array<[number, number]> } } : {}),
    };
  } else {
    const thread = pick(random, threads);
    const own = thread.messages.filter((message) => message.authorId === me.userId);
    const message = pick(random, thread.messages);
    if (roll < 0.5) {
      action = { type: 'reply', threadId: thread.id, messageId: `msg-${clientId}-${n}`, text: `Réponse ${n}`, at };
    } else if (roll < 0.6) {
      action = { type: 'set-resolved', threadId: thread.id, resolved: thread.resolvedAt === undefined, at };
    } else if (roll < 0.72) {
      action = { type: 'toggle-reaction', threadId: thread.id, messageId: message.id, emoji: pick(random, COMMENT_REACTIONS.slice(0, 3)) };
    } else if (roll < 0.82 && own.length > 0) {
      action = { type: 'edit-message', threadId: thread.id, messageId: pick(random, own).id, text: `Modifié ${n}`, at };
    } else if (roll < 0.9 && own.length > 0) {
      action = { type: 'delete-message', threadId: thread.id, messageId: pick(random, own).id };
    } else if (thread.createdBy === me.userId) {
      action = { type: 'move-thread', threadId: thread.id, anchor: { ...thread.anchor, lng: thread.anchor.lng + 0.001 } };
    } else {
      action = { type: 'reply', threadId: thread.id, messageId: `msg-${clientId}-${n}`, text: `Réponse ${n}`, at };
    }
  }
  const comments = applyCommentAction(threads, action, me);
  if (!comments) return null;
  const next = { ...document };
  if (comments.length > 0) next.comments = [...comments];
  else delete next.comments;
  return { document: next, change: 'comment' };
}

/** Modification aléatoire de `document` par `clientId` (n-ième de ce client). */
export function randomEdit(document: ProjectDocument, random: Random, clientId: string, n: number): Edit {
  if (random() < 0.15) return randomCommentEdit(document, random, clientId, n);
  const list = editable(document);
  const roll = random();
  if (list.length === 0 || roll < 0.03) {
    const id = `it-${clientId}-${n}`;
    return {
      document: { ...document, itineraries: [...itineraries(document), sampleItinerary(id, `Ajout ${n}`, random() < 0.5 ? 300 : 0)] } as ProjectDocument,
      change: 'step',
    };
  }
  const target = pick(random, list);
  if (roll < 0.05 && list.length > 1) {
    return {
      document: { ...document, itineraries: itineraries(document).filter((itinerary) => itinerary.id !== target.id) } as ProjectDocument,
      change: 'step',
    };
  }
  if (roll < 0.15) {
    return { document: withItinerary(document, target.id, (it) => ({ ...it, name: `${clientId} ${n}` })), change: 'user' };
  }
  if (roll < 0.25) {
    const key = pick(random, ['duration', 'elevation', 'distance', 'tranquility']);
    return {
      document: withItinerary(document, target.id, (it) => ({ ...it, priorities: { ...it.priorities, [key]: Math.floor(random() * 100) } })),
      change: 'user',
    };
  }
  if (roll < 0.35) {
    // Ajout d'un point de passage.
    return {
      document: withItinerary(document, target.id, (it) => {
        const timeline = [...it.timeline];
        const index = 1 + Math.floor(random() * Math.max(1, timeline.length - 1));
        timeline.splice(index, 0, { id: `wp-${clientId}-${n}`, kind: 'waypoint', label: `P${n}`, distanceKm: null, lat: 45.9 + random() * 0.1, lon: 6.8 + random() * 0.1 } as never);
        return { ...it, timeline };
      }),
      change: 'step',
    };
  }
  if (roll < 0.43) {
    // Suppression d'un point de passage.
    const waypoints = target.timeline.filter((row) => row.kind === 'waypoint');
    if (waypoints.length === 0) return null;
    const removed = pick(random, waypoints).id;
    return {
      document: withItinerary(document, target.id, (it) => ({ ...it, timeline: it.timeline.filter((row) => row.id !== removed) })),
      change: 'step',
    };
  }
  if (roll < 0.53) {
    // Déplacement d'un point dans la feuille de route.
    if (target.timeline.length < 3) return null;
    return {
      document: withItinerary(document, target.id, (it) => {
        const timeline = [...it.timeline];
        const from = Math.floor(random() * timeline.length);
        const [row] = timeline.splice(from, 1);
        timeline.splice(Math.floor(random() * (timeline.length + 1)), 0, row);
        return { ...it, timeline };
      }),
      change: 'step',
    };
  }
  if (roll < 0.63) {
    // Libellé d'une ligne.
    const row = pick(random, target.timeline);
    if (!row) return null;
    return {
      document: withItinerary(document, target.id, (it) => ({
        ...it,
        timeline: it.timeline.map((line) => (line.id === row.id ? { ...line, label: `${clientId}:${n}` } : line)),
      })),
      change: 'user',
    };
  }
  if (roll < 0.73) {
    // Tracé recalculé : une fenêtre remplacée (résultat d'arrière-plan).
    return {
      document: withItinerary(document, target.id, (it) => {
        const points = [...((it.gpxRoute?.points ?? routePoints(200)) as RoutePoint[])];
        const start = Math.floor(random() * Math.max(1, points.length - 50));
        points.splice(start, Math.floor(random() * 40), ...routePoints(10 + Math.floor(random() * 60), n % 97));
        return { ...it, gpxRoute: { name: null, source: 'brouter', points, routedInputsKey: `${clientId}-${n}` } } as Itinerary;
      }),
      change: 'background',
    };
  }
  if (roll < 0.8) {
    // Pauses (liste imbriquée dans le rythme).
    return {
      document: withItinerary(document, target.id, (it) => {
        const pauses = [...(it.rhythm?.pauseIntervals ?? [])];
        if (pauses.length > 0 && random() < 0.4) pauses.splice(Math.floor(random() * pauses.length), 1);
        else pauses.push({ id: `pause-${clientId}-${n}`, label: `Pause ${n}`, durationMin: 5, intervalMin: 30 + n } as never);
        return { ...it, rhythm: { ...it.rhythm, pauseIntervals: pauses } } as Itinerary;
      }),
      change: 'step',
    };
  }
  if (roll < 0.86) {
    // Zones interdites.
    return {
      document: withItinerary(document, target.id, (it) => {
        const zones = [...(it.forbiddenZones ?? [])];
        if (zones.length > 0 && random() < 0.5) zones.splice(Math.floor(random() * zones.length), 1);
        else zones.push({ id: `zone-${clientId}-${n}`, center: { lat: 45.9, lon: 6.9 }, radiusM: 100 + n } as never);
        return { ...it, forbiddenZones: zones } as Itinerary;
      }),
      change: 'step',
    };
  }
  if (roll < 0.93) {
    return { document: withItinerary(document, target.id, (it) => ({ ...it, color: pick(random, ['#c50000', '#3d8bff', '#22aa55', '#ffaa00']) })), change: 'user' };
  }
  // Ordre des itinéraires (les compteurs restent premiers).
  const all = [...itineraries(document)];
  const fixed = all[0]?.id === COUNTERS_ITINERARY_ID ? 1 : 0;
  if (all.length - fixed < 2) return null;
  const from = fixed + Math.floor(random() * (all.length - fixed));
  const [moved] = all.splice(from, 1);
  all.splice(fixed + Math.floor(random() * (all.length - fixed + 1)), 0, moved);
  return { document: { ...document, itineraries: all } as ProjectDocument, change: 'step' };
}
