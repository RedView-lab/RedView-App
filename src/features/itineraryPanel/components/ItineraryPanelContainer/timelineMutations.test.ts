import { describe, expect, it } from 'vitest';

import { getRoutingInputsSignature, routeStampMatches } from '../../hooks/useItineraryBrouterRouting/routingInputs';
import { createDefaultItinerary } from '../../lib/project';
import { haversineRouteDistanceM } from '../../lib/routes';
import type { Itinerary } from '../../types';

import { buildPendingRoutePatchForEditedRow, placeRouteEndpoint } from './timelineMutations';

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;
const at = (km: number, eastM = 0) => ({
  lat: 44 + km / KM_PER_DEGREE,
  lon: 6 + eastM / (111_320 * Math.cos((44 * Math.PI) / 180)),
});

/** Itinéraire routé du km 0 au km `km` (un point par km), départ / arrivée posés, estampillé. */
function routedItinerary(km: number, rows: Itinerary['timeline'] = []): Itinerary {
  const itinerary = createDefaultItinerary();
  itinerary.timeline = [
    { id: 'start', kind: 'start', label: 'A', distanceKm: 0, ...at(0) },
    ...rows,
    { id: 'end', kind: 'end', label: 'B', distanceKm: km, ...at(km) },
  ];
  const points = Array.from({ length: km + 1 }, (_, index) => ({ ...at(index), distanceM: index * 1_000, elevationM: 100 }));
  itinerary.gpxRoute = { name: null, points, originalPoints: points, source: 'brouter' };
  itinerary.gpxRoute.routedInputsKey = getRoutingInputsSignature(itinerary);
  return itinerary;
}

function longestStepM(points: ReadonlyArray<{ lat: number; lon: number }>): number {
  let longest = 0;
  for (let index = 1; index < points.length; index += 1) {
    longest = Math.max(longest, haversineRouteDistanceM(points[index - 1]!, points[index]!));
  }
  return longest;
}

describe('placeRouteEndpoint on the route (crop)', () => {
  it('« Démarrer ici » on the route cuts the stored route there, without routing', () => {
    const itinerary = routedItinerary(100);

    placeRouteEndpoint(itinerary, 'start', at(30.5), 'Ici', { routeDistanceM: 30_500 });

    const route = itinerary.gpxRoute!;
    expect(itinerary.pendingRoutePatch).toBeUndefined();
    expect(route.points[0]!.lat).toBeCloseTo(at(30.5).lat, 9);
    expect(route.points[route.points.length - 1]!.lat).toBeCloseTo(at(100).lat, 9);
    expect(longestStepM(route.points)).toBeLessThan(1_001);
    expect(itinerary.metrics?.distanceKm).toBeCloseTo(69.5, 1);
    const start = itinerary.timeline.find((row) => row.kind === 'start')!;
    expect(start).toMatchObject({ label: 'Ici', distanceKm: 0 });
    expect(start.lat).toBeCloseTo(route.points[0]!.lat, 9);
    // Stamped for the new start: the routing effect does not recompute it.
    expect(routeStampMatches(itinerary, route.routedInputsKey)).toBe(true);
  });

  it('« Finir ici » from a right click a few metres off the trace cuts the end', () => {
    const itinerary = routedItinerary(50);

    placeRouteEndpoint(itinerary, 'end', at(20, 12), 'Fin', { pickToleranceM: 30 });

    const points = itinerary.gpxRoute!.points;
    expect(itinerary.pendingRoutePatch).toBeUndefined();
    expect(points).toHaveLength(21);
    expect(points[20]!.lat).toBeCloseTo(at(20).lat, 9);
    expect(itinerary.timeline.find((row) => row.kind === 'end')?.distanceKm).toBeCloseTo(20, 1);
  });

  it('keeps an imported GPX as the file, cropped (no rerouting of its kept part)', () => {
    const itinerary = routedItinerary(40);
    itinerary.gpxRoute = { ...itinerary.gpxRoute!, source: 'gpx', routedInputsKey: undefined };

    placeRouteEndpoint(itinerary, 'start', at(10), 'Ici', { routeDistanceM: 10_000 });

    expect(itinerary.gpxRoute!.source).toBe('gpx');
    expect(itinerary.gpxRoute!.points).toHaveLength(31);
    expect(itinerary.gpxRoute!.originalPoints).toHaveLength(31);
  });

  it('reroutes instead of cropping when an imposed step lies in the removed part', () => {
    const itinerary = routedItinerary(100, [
      { id: 'wp', kind: 'waypoint', label: 'Col', distanceKm: 10, ...at(10) },
    ]);

    placeRouteEndpoint(itinerary, 'start', at(30), 'Ici', { routeDistanceM: 30_000 });

    expect(itinerary.gpxRoute!.points).toHaveLength(101);
    expect(itinerary.pendingRoutePatch?.start.kind).toBe('start');
  });

  it('reroutes from a start placed off the route (patch from the new start)', () => {
    const itinerary = routedItinerary(100);

    placeRouteEndpoint(itinerary, 'start', at(30, 2_000), 'Hôtel');

    expect(itinerary.gpxRoute!.points).toHaveLength(101);
    expect(itinerary.pendingRoutePatch?.start).toMatchObject({ kind: 'start', ...at(30, 2_000) });
  });
});

describe('buildPendingRoutePatchForEditedRow', () => {
  it('gives intermediate bounds their position on the route (loops, out-and-backs)', () => {
    const itinerary = routedItinerary(100, [
      { id: 'a', kind: 'waypoint', label: 'A', distanceKm: 20, ...at(20) },
      { id: 'b', kind: 'waypoint', label: 'B', distanceKm: 40, ...at(40) },
      { id: 'c', kind: 'waypoint', label: 'C', distanceKm: 60, ...at(60) },
    ]);

    const patch = buildPendingRoutePatchForEditedRow(itinerary, 'b');

    expect(patch?.start).toMatchObject({ kind: 'waypoint', distanceM: 20_000 });
    expect(patch?.end).toMatchObject({ kind: 'waypoint', distanceM: 60_000 });
  });
});
