import { describe, expect, it } from 'vitest';

import { getRoutingInputsSignature } from '../../hooks/useItineraryBrouterRouting/routingInputs';
import { createDefaultItinerary } from '../../lib/project';
import type { Itinerary } from '../../types';

import { applyLidarViewerRouteEdit } from './lidarViewerRouteEdit';

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;
const at = (km: number, eastM = 0) => ({
  lat: 44 + km / KM_PER_DEGREE,
  lon: 6 + eastM / (111_320 * Math.cos((44 * Math.PI) / 180)),
});

/** Itinéraire routé du km 0 au km `km` (un point par km), estampillé. */
function routedItinerary(km: number, rows: Itinerary['timeline'] = []): Itinerary {
  const itinerary = createDefaultItinerary();
  itinerary.timeline = [
    { id: 'start', kind: 'start', label: 'A', distanceKm: 0, ...at(0) },
    ...rows,
    { id: 'end', kind: 'end', label: 'B', distanceKm: km, ...at(km) },
  ];
  const points = Array.from({ length: km + 1 }, (_, index) => ({ ...at(index), distanceM: index * 1_000 }));
  itinerary.gpxRoute = { name: null, points, originalPoints: points, source: 'brouter' };
  itinerary.gpxRoute.routedInputsKey = getRoutingInputsSignature(itinerary);
  return itinerary;
}

const viewerPoints = (itinerary: Itinerary) => itinerary.gpxRoute!.points.map(({ lat, lon }) => ({ lat, lon }));

describe('applyLidarViewerRouteEdit', () => {
  it('turns a dragged route point into a step and a local reroute (no spike)', () => {
    const itinerary = routedItinerary(20);
    const next = viewerPoints(itinerary);
    next[10] = at(10, 800);

    expect(applyLidarViewerRouteEdit(itinerary, next, 'move_point')).toBe('applied');

    expect(itinerary.gpxRoute!.points).toHaveLength(21);
    const step = itinerary.timeline.find((row) => row.kind === 'waypoint')!;
    expect(step.lat).toBeCloseTo(at(10, 800).lat, 9);
    expect(itinerary.pendingRoutePatch?.via).toEqual([{ lat: step.lat, lon: step.lon }]);
  });

  it('crops when the start is placed on the route, reroutes when placed off it', () => {
    const cropped = routedItinerary(20);
    const onRoute = [at(8), ...viewerPoints(cropped).slice(9)];
    expect(applyLidarViewerRouteEdit(cropped, onRoute, 'set_start')).toBe('applied');
    expect(cropped.gpxRoute!.points[0]!.lat).toBeCloseTo(at(8).lat, 9);
    expect(cropped.pendingRoutePatch).toBeUndefined();

    const moved = routedItinerary(20);
    const offRoute = [at(0, 3_000), ...viewerPoints(moved).slice(1)];
    expect(applyLidarViewerRouteEdit(moved, offRoute, 'set_start')).toBe('applied');
    expect(moved.gpxRoute!.points).toHaveLength(21);
    expect(moved.pendingRoutePatch?.start.kind).toBe('start');
  });

  it('adds a step, extends the route from its end, removes a step', () => {
    const added = routedItinerary(20);
    const withStep = viewerPoints(added);
    withStep.splice(5, 0, at(4.5, 1_000));
    expect(applyLidarViewerRouteEdit(added, withStep, 'add_waypoint')).toBe('applied');
    expect(added.pendingRoutePatch?.via).toHaveLength(1);

    const extended = routedItinerary(20);
    expect(applyLidarViewerRouteEdit(extended, [...viewerPoints(extended), at(25)], 'append_point')).toBe('applied');
    expect(extended.pendingTraceExtension).toEqual({ from: { lat: at(20).lat, lon: at(20).lon }, to: at(25) });

    const removed = routedItinerary(20, [{ id: 'wp', kind: 'waypoint', label: 'Col', distanceKm: 7, ...at(7) }]);
    const withoutStep = viewerPoints(removed).filter((_, index) => index !== 7);
    expect(applyLidarViewerRouteEdit(removed, withoutStep, 'delete_point')).toBe('applied');
    expect(removed.timeline.some((row) => row.id === 'wp')).toBe(false);
    expect(removed.pendingRoutePatch).toBeDefined();
  });

  it('ignores gestures without a routed meaning and an out-of-sync viewer', () => {
    const itinerary = routedItinerary(20);
    const points = viewerPoints(itinerary);

    const onRoute = [...points];
    onRoute.splice(3, 0, at(2.5));
    expect(applyLidarViewerRouteEdit(itinerary, onRoute, 'insert_point')).toBe('ignored');
    const plainPointRemoved = points.filter((_, index) => index !== 4);
    expect(applyLidarViewerRouteEdit(itinerary, plainPointRemoved, 'delete_point')).toBe('ignored');
    const twoMoved = [...points];
    twoMoved[3] = at(3, 500);
    twoMoved[9] = at(9, 500);
    expect(applyLidarViewerRouteEdit(itinerary, twoMoved, 'move_point')).toBe('ignored');
    expect(itinerary.pendingRoutePatch).toBeUndefined();
    expect(itinerary.gpxRoute!.points).toHaveLength(21);
  });

  it('keeps imported and viewer-drawn routes freehand, and harmless gestures raw', () => {
    const gpx = routedItinerary(20);
    gpx.gpxRoute!.source = 'gpx';
    const next = viewerPoints(gpx);
    next[10] = at(10, 800);
    expect(applyLidarViewerRouteEdit(gpx, next, 'move_point')).toBe('raw');

    const routed = routedItinerary(20);
    expect(applyLidarViewerRouteEdit(routed, viewerPoints(routed).reverse(), 'reverse_route')).toBe('raw');
  });
});
