import { describe, expect, it } from 'vitest';

import { getRoutingInputsSignature } from '../../hooks/useItineraryBrouterRouting/routingInputs';
import { haversineRouteDistanceM } from '../routes';
import type { Itinerary } from '../../types';

import { createDefaultItinerary } from './defaultState';
import { repairRouteEndpointArtifacts } from './repair-route-endpoints';

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;
const at = (km: number) => ({ lat: 44 + km / KM_PER_DEGREE, lon: 6 });

/** Itinéraire BRouter du km `fromKm` au km `toKm` (un point par km), estampillé. */
function routedItinerary(fromKm: number, toKm: number, extraPoints: { head?: { lat: number; lon: number }; tail?: { lat: number; lon: number } } = {}): Itinerary {
  const itinerary = createDefaultItinerary();
  itinerary.timeline = [
    { id: 'start', kind: 'start', label: 'A', distanceKm: 0, ...at(fromKm) },
    { id: 'end', kind: 'end', label: 'B', distanceKm: null, ...at(toKm) },
  ];
  const points = [
    ...(extraPoints.head ? [extraPoints.head] : []),
    ...Array.from({ length: toKm - fromKm + 1 }, (_, index) => at(fromKm + index)),
    ...(extraPoints.tail ? [extraPoints.tail] : []),
  ];
  let distanceM = 0;
  const stored = points.map((point, index) => {
    if (index > 0) distanceM += haversineRouteDistanceM(points[index - 1]!, point);
    return { ...point, distanceM, elevationM: 100 };
  });
  itinerary.gpxRoute = { name: null, points: stored, originalPoints: stored, source: 'brouter' };
  itinerary.gpxRoute.routedInputsKey = getRoutingInputsSignature(itinerary);
  return itinerary;
}

describe('repairRouteEndpointArtifacts', () => {
  it('removes the old start left before the new one (straight line)', () => {
    // Départ déplacé du km 0 au km 30 : l'ancien départ (km 0) est resté en premier point.
    const broken = routedItinerary(30, 60, { head: at(0) });

    const repaired = repairRouteEndpointArtifacts(broken);

    expect(repaired.gpxRoute!.points).toHaveLength(31);
    expect(repaired.gpxRoute!.points[0]!.lat).toBeCloseTo(at(30).lat, 9);
    expect(repaired.gpxRoute!.points[0]!.distanceM).toBe(0);
    expect(repaired.metrics?.distanceKm).toBeCloseTo(30, 0);
  });

  it('removes the old end left after the new one', () => {
    const broken = routedItinerary(0, 20, { tail: at(45) });

    const repaired = repairRouteEndpointArtifacts(broken);

    expect(repaired.gpxRoute!.points).toHaveLength(21);
    expect(repaired.gpxRoute!.points[20]!.lat).toBeCloseTo(at(20).lat, 9);
  });

  it('leaves a clean route, a route waiting for its recalculation and an imported GPX untouched', () => {
    const clean = routedItinerary(0, 20);
    expect(repairRouteEndpointArtifacts(clean)).toBe(clean);

    const pending = routedItinerary(30, 60, { head: at(0) });
    pending.pendingRoutePatch = { start: { ...at(30), kind: 'start' }, end: { ...at(60), kind: 'end' }, via: [] };
    expect(repairRouteEndpointArtifacts(pending)).toBe(pending);

    const stale = routedItinerary(30, 60, { head: at(0) });
    stale.gpxRoute!.routedInputsKey = 'other inputs';
    expect(repairRouteEndpointArtifacts(stale)).toBe(stale);

    const gpx = routedItinerary(30, 60, { head: at(0) });
    gpx.gpxRoute!.source = 'gpx';
    expect(repairRouteEndpointArtifacts(gpx)).toBe(gpx);
  });

  it('keeps a start snapped onto the network away from the clicked point', () => {
    // Départ cliqué à 80 m à l'ouest de la route : le tracé démarre à sa projection.
    const itinerary = routedItinerary(0, 10);
    const clicked = { lat: at(0).lat, lon: 6 - 80 / (111_320 * Math.cos((44 * Math.PI) / 180)) };
    itinerary.timeline[0] = { ...itinerary.timeline[0]!, ...clicked };
    itinerary.gpxRoute!.routedInputsKey = getRoutingInputsSignature(itinerary);

    expect(repairRouteEndpointArtifacts(itinerary)).toBe(itinerary);
  });
});
