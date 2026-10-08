import { describe, expect, it } from 'vitest';

import type { Itinerary, ItineraryProject } from '../../types';
import { createDefaultItinerary, createDefaultProject, normalizeItineraryProject } from './defaultState';
import { composeProject, readStoredProject, toProjectDocument } from './layers';
import { packStoredDocument, unpackStoredDocument } from './storedRoutes';

/**
 * Forme stockée des tracés : un `originalPoints` identique à `points` n'est
 * écrit qu'une fois, et la lecture rend exactement le projet écrit.
 */

type Route = NonNullable<Itinerary['gpxRoute']>;

function routePoints(count: number, offset = 0): Route['points'] {
  return Array.from({ length: count }, (_, index) => ({
    lat: 45 + index * 0.001,
    lon: 6 + index * 0.001 + offset,
    distanceM: index * 111.19492664455873,
    elevationM: 400 + index,
    gradientPct: 0.12121212121201097 * index,
    surface: 'asphalt' as const,
    wayCode: 68,
  }));
}

function withRoute(index: number, route: Partial<Route> | null): Itinerary {
  const itinerary = createDefaultItinerary(index);
  return route ? { ...itinerary, gpxRoute: { name: null, points: [], ...route } } : itinerary;
}

function documentOf(...itineraries: Itinerary[]) {
  const project: ItineraryProject = { ...createDefaultProject(), name: 'Tour', itineraries, activeItineraryId: itineraries[0]?.id ?? '' };
  return toProjectDocument(project);
}

const roundTrip = (document: ReturnType<typeof documentOf>) =>
  readStoredProject(JSON.parse(JSON.stringify(packStoredDocument(document))))!.document;

describe('packStoredDocument / unpackStoredDocument', () => {
  const points = routePoints(200);
  const routed = withRoute(1, { source: 'brouter', points, originalPoints: points });
  const reloaded = withRoute(2, { source: 'brouter', points, originalPoints: structuredClone(points) });
  const simplified = withRoute(3, { source: 'gpx', points: points.filter((_, index) => index % 4 === 0), originalPoints: points });
  const noOriginal = withRoute(4, { source: 'gpx', points });
  const noRoute = withRoute(5, null);
  const document = documentOf(routed, reloaded, simplified, noOriginal, noRoute);

  it("n'écrit qu'une fois un tracé identique (même tableau, ou copie égale relue d'un ancien stockage)", () => {
    const full = JSON.stringify(document);
    const packed = JSON.stringify(packStoredDocument(document));
    const one = JSON.stringify(points).length;
    expect(full.length - packed.length).toBeGreaterThan(2 * one - 200);
    const stored = JSON.parse(packed) as { itineraries: Array<{ gpxRoute?: Record<string, unknown> }> };
    expect(stored.itineraries.map((itinerary) => itinerary.gpxRoute && 'originalPoints' in itinerary.gpxRoute)).toEqual([false, false, true, false, undefined]);
  });

  it('la lecture rend le document écrit, avec le même tableau pour les deux', () => {
    const read = roundTrip(document);
    expect(read).toEqual(document);
    const [a, b, c, d, e] = read.itineraries;
    expect(a.gpxRoute!.originalPoints).toBe(a.gpxRoute!.points);
    expect(b.gpxRoute!.originalPoints).toBe(b.gpxRoute!.points);
    expect(c.gpxRoute!.originalPoints).not.toBe(c.gpxRoute!.points);
    expect(c.gpxRoute!.originalPoints).toHaveLength(200);
    expect(d.gpxRoute!.originalPoints).toBeUndefined();
    expect(e.gpxRoute).toBeUndefined();
    expect(JSON.stringify(read).includes('originalPointsSameAsPoints')).toBe(false);
  });

  it('un document sans tracé dédoublonné reste le même objet', () => {
    const plain = documentOf(simplified, noOriginal, noRoute);
    expect(packStoredDocument(plain)).toBe(plain);
    expect(unpackStoredDocument(plain)).toBe(plain);
  });

  it('un tracé qui diffère d’un seul point garde ses deux copies', () => {
    const edited = structuredClone(points);
    edited[120] = { ...edited[120]!, elevationM: 999 };
    const route = withRoute(1, { points, originalPoints: edited });
    const read = roundTrip(documentOf(route));
    expect(read.itineraries[0]!.gpxRoute!.originalPoints).toEqual(edited);
  });

  it("un originalPoints réellement écrit l'emporte sur une marque restée d'une lecture plus ancienne", () => {
    const other = routePoints(50, 1);
    const stored = JSON.parse(JSON.stringify(documentOf(withRoute(1, { points, originalPoints: other }))));
    stored.itineraries[0].gpxRoute.originalPointsSameAsPoints = true;
    const read = unpackStoredDocument(stored);
    expect(read.itineraries[0]!.gpxRoute!.originalPoints).toEqual(other);
    expect('originalPointsSameAsPoints' in read.itineraries[0]!.gpxRoute!).toBe(false);
  });

  it('une version qui ignore la marque lit un tracé sans originalPoints', () => {
    const stored = JSON.parse(JSON.stringify(packStoredDocument(documentOf(routed))));
    const project = normalizeItineraryProject(composeProject(stored));
    expect(project.itineraries[0]!.gpxRoute!.points).toHaveLength(200);
    expect(project.itineraries[0]!.gpxRoute!.originalPoints).toBeUndefined();
  });
});
