import { describe, expect, it } from 'vitest';

import { createDefaultItinerary } from '../../lib/project';
import type { Itinerary } from '../../types';

import { collectItineraryCheckpoints } from './collectCheckpoints';

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;
const at = (km: number, eastM = 0) => ({
  lat: 44 + km / KM_PER_DEGREE,
  lon: 6 + eastM / (111_320 * Math.cos((44 * Math.PI) / 180)),
});

const visibility = { pausesEnabled: true, waypointsEnabled: true, favorisEnabled: true };

function routedItinerary(km: number, rows: Itinerary['timeline'] = []): Itinerary {
  const itinerary = createDefaultItinerary();
  itinerary.timeline = [
    { id: 'start', kind: 'start', label: 'A', distanceKm: 0, ...at(0) },
    ...rows,
    { id: 'end', kind: 'end', label: 'B', distanceKm: km, ...at(km) },
  ];
  const points = Array.from({ length: km + 1 }, (_, index) => ({ ...at(index), distanceM: index * 1_000, elevationM: 100 }));
  itinerary.gpxRoute = { name: null, points, originalPoints: points, source: 'brouter' };
  return itinerary;
}

function checkpoint(itinerary: Itinerary, kind: string) {
  return collectItineraryCheckpoints(itinerary, visibility).find((cp) => cp.kind === kind);
}

describe('collectItineraryCheckpoints', () => {
  it('draws a step on the route once the route is up to date', () => {
    const itinerary = routedItinerary(50, [
      { id: 'wp', kind: 'waypoint', label: 'Col', distanceKm: 20, ...at(20, 40) },
    ]);

    const coord = checkpoint(itinerary, 'waypoint')!.coord;

    expect(coord[0]).toBeCloseTo(at(20).lon, 6);
    expect(coord[1]).toBeCloseTo(at(20).lat, 6);
  });

  it('keeps a moved step where it was dropped while its rerouting is pending', () => {
    const dropped = at(20, 3_000);
    const itinerary = routedItinerary(50, [
      { id: 'wp', kind: 'waypoint', label: 'Col', distanceKm: 20, ...dropped },
    ]);
    itinerary.pendingRoutePatch = { start: { ...at(0), kind: 'start' }, end: { ...at(50), kind: 'end' }, via: [dropped] };

    expect(checkpoint(itinerary, 'waypoint')!.coord).toEqual([dropped.lon, dropped.lat]);
  });

  it('shows a moved end at its row, not at the end of the old route, while rerouting', () => {
    const itinerary = routedItinerary(50);
    const moved = at(60, 500);
    const end = itinerary.timeline.find((row) => row.kind === 'end')!;
    Object.assign(end, moved);
    itinerary.pendingRoutePatch = { start: { ...at(0), kind: 'start' }, end: { ...moved, kind: 'end' }, via: [] };

    expect(checkpoint(itinerary, 'end')!.coord).toEqual([moved.lon, moved.lat]);
  });

  it('shows the new end of an extension at once (the old end becomes a step)', () => {
    const itinerary = routedItinerary(50);
    const extended = at(70);
    Object.assign(itinerary.timeline.find((row) => row.kind === 'end')!, extended);
    itinerary.pendingTraceExtension = { from: at(50), to: extended };

    expect(checkpoint(itinerary, 'end')!.coord).toEqual([extended.lon, extended.lat]);
  });

  it('offers « Supprimer » on start and end only when a placed step can replace them', () => {
    const alone = routedItinerary(50);
    expect(checkpoint(alone, 'start')!.removable).toBe(false);
    expect(checkpoint(alone, 'end')!.removable).toBe(false);

    const withStep = routedItinerary(50, [
      { id: 'wp', kind: 'waypoint', label: 'Col', distanceKm: 20, ...at(20) },
    ]);
    expect(checkpoint(withStep, 'start')!.removable).toBe(true);
    expect(checkpoint(withStep, 'end')!.removable).toBe(true);
    // La popup est rafraîchie quand ceci change.
    expect(checkpoint(withStep, 'end')!.signature).not.toBe(checkpoint(alone, 'end')!.signature);
  });
});
