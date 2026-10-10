import { describe, expect, it } from 'vitest';

import { getRoutingInputsSignature, routeStampMatches } from '../../hooks/useItineraryBrouterRouting/routingInputs';
import type { ItineraryProject } from '../../types';

import { createDefaultItinerary, createDefaultProject } from './defaultState';
import { splitItineraryProject } from './split-itinerary';

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;

describe('splitItineraryProject', () => {
  it('gives each half exactly its part of the route, stamped so it is not rerouted', () => {
    const itinerary = createDefaultItinerary();
    const points = Array.from({ length: 21 }, (_, index) => ({
      lat: 44 + index / KM_PER_DEGREE,
      lon: 6,
      distanceM: index * 1_000,
      elevationM: 100,
    }));
    itinerary.timeline = [
      { id: 'start', kind: 'start', label: 'A', distanceKm: 0, lat: points[0]!.lat, lon: 6 },
      { id: 'end', kind: 'end', label: 'B', distanceKm: 20, lat: points[20]!.lat, lon: 6 },
    ];
    itinerary.gpxRoute = { name: null, points, originalPoints: points, source: 'brouter' };
    itinerary.gpxRoute.routedInputsKey = getRoutingInputsSignature(itinerary);
    itinerary.pendingRoutePatch = { start: { lat: 44, lon: 6, kind: 'start' }, end: { lat: 44.1, lon: 6, kind: 'end' }, via: [] };
    const project: ItineraryProject = { ...createDefaultProject(), itineraries: [itinerary], activeItineraryId: itinerary.id };

    const result = splitItineraryProject(project, itinerary.id, 8)!;

    const [left, right] = result.project.itineraries;
    expect(left!.gpxRoute!.points).toHaveLength(9);
    expect(right!.gpxRoute!.points).toHaveLength(13);
    // L'export GPX lit originalPoints : jamais tout l'ancien tracé.
    expect(left!.gpxRoute!.originalPoints).toHaveLength(9);
    expect(right!.gpxRoute!.originalPoints).toHaveLength(13);
    for (const half of [left!, right!]) {
      expect(half.pendingRoutePatch).toBeUndefined();
      expect(routeStampMatches(half, half.gpxRoute!.routedInputsKey)).toBe(true);
    }
  });

  it('keeps each half its own roadbook rows and the full-resolution track of an imported GPX (F2-1)', () => {
    const itinerary = createDefaultItinerary();
    const at = (km: number) => ({ lat: 44 + km / KM_PER_DEGREE, lon: 6 });
    // GPX importé : 1 001 points d'origine (10 m), tracé simplifié à 101 points (100 m).
    const original = Array.from({ length: 1_001 }, (_, index) => ({ ...at(index / 100), elevationM: 100 + index / 10 }));
    const points = Array.from({ length: 101 }, (_, index) => ({ ...at(index / 10), distanceM: index * 100, elevationM: 100 + index }));
    itinerary.timeline = [
      { id: 'start', kind: 'start', label: 'Chamonix', distanceKm: 0, ...at(0) },
      { id: 'col', kind: 'waypoint', label: 'Col (ravito)', distanceKm: 3, ...at(3) },
      { id: 'pause-1', kind: 'pause', label: 'Pause', distanceKm: 4, durationMin: 20 },
      { id: 'poi-9', kind: 'poi', label: 'Hôtel réservé', labelEdited: true, distanceKm: 7, ...at(7), poiCategory: 'hotels', osmId: 9, favorite: true, durationMin: 480 },
      { id: 'end', kind: 'end', label: 'Aoste', distanceKm: 10, ...at(10) },
    ];
    itinerary.gpxRoute = { name: 'Ultra', points, originalPoints: original, source: 'gpx' };
    itinerary.poiFeatures = [{ id: 9, category: 'hotel', name: 'Hôtel', tags: {}, ...at(7), favorite: true, pauseDurationMin: 480 }];
    const project: ItineraryProject = { ...createDefaultProject(), itineraries: [itinerary], activeItineraryId: itinerary.id };

    const result = splitItineraryProject(project, itinerary.id, 50)!;

    const [left, right] = result.project.itineraries;
    expect(left!.timeline.map((row) => [row.kind, row.label])).toEqual([
      ['start', 'Chamonix'], ['waypoint', 'Col (ravito)'], ['pause', 'Pause'], ['end', expect.any(String)],
    ]);
    expect(right!.timeline.map((row) => [row.kind, row.label])).toEqual([
      ['start', expect.any(String)], ['poi', 'Hôtel réservé'], ['end', 'Aoste'],
    ]);
    const hotel = right!.timeline.find((row) => row.osmId === 9)!;
    expect(hotel).toMatchObject({ favorite: true, durationMin: 480, distanceKm: 2 });
    expect(right!.timeline.at(-1)!.distanceKm).toBe(5);
    expect(left!.timeline.at(-1)!.lat).toBeCloseTo(at(5).lat, 9);
    expect(right!.timeline[0]!.lat).toBeCloseTo(at(5).lat, 9);
    // Le POI favori suit sa ligne, sur la carte aussi.
    expect(right!.poiFeatures?.map((feature) => feature.id)).toEqual([9]);
    expect(left!.poiFeatures ?? []).toEqual([]);
    // Résolution d'origine gardée de part et d'autre de la coupe.
    expect(left!.gpxRoute!.originalPoints!.length + right!.gpxRoute!.originalPoints!.length).toBeGreaterThanOrEqual(1_001);
    expect(left!.gpxRoute!.originalPoints!.at(-1)!.lat).toBeCloseTo(at(5).lat, 9);
  });
});
