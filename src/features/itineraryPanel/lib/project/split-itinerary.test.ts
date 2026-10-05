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
    // The GPX export reads originalPoints: never the whole former route.
    expect(left!.gpxRoute!.originalPoints).toHaveLength(9);
    expect(right!.gpxRoute!.originalPoints).toHaveLength(13);
    for (const half of [left!, right!]) {
      expect(half.pendingRoutePatch).toBeUndefined();
      expect(routeStampMatches(half, half.gpxRoute!.routedInputsKey)).toBe(true);
    }
  });
});
