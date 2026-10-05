import { describe, expect, it, vi } from 'vitest';

import { isRouteSeamError } from '../../lib/routes';
import type { BrouterRoute } from '../../lib/brouter';
import type { ItineraryPendingRoutePatch } from '../../types/itinerary';
import { narrowRoutePatchToEdit, type RoutePoints } from '../useItineraryBrouterRoutingShared';

import { resolveElasticRoutePatch } from './elasticRoutePatch';
import type { ResolvedRouteRequest } from './resolveRouteRequest';

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;

/** Route along the 6°E meridian, one point per km. */
function meridianRoute(km: number): RoutePoints {
  return Array.from({ length: km + 1 }, (_, index) => ({ lat: 44 + index / KM_PER_DEGREE, lon: 6, distanceM: index * 1000 }));
}

function resolved(coordinates: [number, number][]): ResolvedRouteRequest {
  const route = { coordinates, distanceM: 0, durationS: 0, ascentM: 0, descentM: 0, raw: { type: 'FeatureCollection', features: [] } };
  return { route: route as unknown as BrouterRoute, resolvedWarnings: [], resolved: {} as ResolvedRouteRequest['resolved'] };
}

const along = (points: RoutePoints, fromKm: number, toKm: number, lonOffset = 0): [number, number][] =>
  points.slice(fromKm, toKm + 1).map((point) => [point.lon + lonOffset, point.lat]);

describe('resolveElasticRoutePatch', () => {
  it('keeps a routed patch that joins the stored route at both bounds', async () => {
    const stored = meridianRoute(30);
    const patch: ItineraryPendingRoutePatch = {
      start: { lat: stored[5]!.lat, lon: stored[5]!.lon, kind: 'waypoint', distanceM: 5_000 },
      end: { lat: stored[25]!.lat, lon: stored[25]!.lon, kind: 'waypoint', distanceM: 25_000 },
      via: [],
    };
    const routePatch = vi.fn(async () => resolved(along(stored, 5, 25)));

    const result = await resolveElasticRoutePatch(patch, stored, new AbortController().signal, routePatch);

    expect(routePatch).toHaveBeenCalledTimes(1);
    expect(result.patch).toBe(patch);
  });

  it('rejects with RouteSeamError instead of drawing a straight line at a real bound', async () => {
    const stored = meridianRoute(30);
    const patch: ItineraryPendingRoutePatch = {
      start: { lat: stored[5]!.lat, lon: stored[5]!.lon, kind: 'waypoint', distanceM: 5_000 },
      end: { lat: stored[25]!.lat, lon: stored[25]!.lon, kind: 'waypoint', distanceM: 25_000 },
      via: [],
    };
    // Snapped ~400 m east of the stored route, never rejoins it.
    const routePatch = vi.fn(async () => resolved(along(stored, 5, 25, 0.005)));

    const error = await resolveElasticRoutePatch(patch, stored, new AbortController().signal, routePatch)
      .catch((reason: unknown) => reason);

    expect(isRouteSeamError(error)).toBe(true);
  });

  it('widens a provisional window bound whose seam fails, then accepts the joined route', async () => {
    const stored = meridianRoute(400);
    const whole: ItineraryPendingRoutePatch = {
      start: { lat: stored[0]!.lat, lon: stored[0]!.lon, kind: 'start' },
      end: { lat: stored[400]!.lat, lon: stored[400]!.lon, kind: 'end' },
      via: [],
    };
    const narrowed = narrowRoutePatchToEdit(whole, stored, { fromM: 200_000, toM: 201_000, projected: false });
    const routePatch = vi.fn(async (current: ItineraryPendingRoutePatch) => (current.start.kind === 'start'
      ? resolved(along(stored, 0, 281))
      // The provisional start (km 119) snaps 400 m away: seam refused.
      : resolved([[6.005, stored[119]!.lat], ...along(stored, 125, 281)])));

    const result = await resolveElasticRoutePatch(narrowed, stored, new AbortController().signal, routePatch);

    expect(routePatch).toHaveBeenCalledTimes(2);
    expect(result.patch.start.kind).toBe('start');
    expect(result.patch.end).toEqual(narrowed.end);
  });
});
