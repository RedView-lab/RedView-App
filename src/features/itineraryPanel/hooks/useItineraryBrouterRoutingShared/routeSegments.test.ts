import { describe, expect, it } from 'vitest';

import type { ItineraryPendingRoutePatch } from '../../types/itinerary';

import { appendRoutePoints, narrowRoutePatchToEdit, replaceRouteSegment, routePointsEqual } from './routeSegments';
import type { RoutePoints } from './types';

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;

/**
 * Route along the 6°E meridian, one point per km. `legsKm` alternate north
 * (positive) and south (negative): `[200, -200]` is an out-and-back.
 */
function meridianRoute(legsKm: number[], startLat = 44): RoutePoints {
  const points: RoutePoints = [{ lat: startLat, lon: 6, distanceM: 0 }];
  let lat = startLat;
  for (const legKm of legsKm) {
    const step = Math.sign(legKm) / KM_PER_DEGREE;
    for (let km = 0; km < Math.abs(legKm); km += 1) {
      lat += step;
      points.push({ lat, lon: 6, distanceM: points.length * 1000 });
    }
  }
  return points;
}

function wholeRoutePatch(points: RoutePoints): ItineraryPendingRoutePatch {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return {
    start: { lat: first.lat, lon: first.lon, kind: 'start' },
    end: { lat: last.lat, lon: last.lon, kind: 'end' },
    via: [],
  };
}

describe('narrowRoutePatchToEdit', () => {
  it('reroutes only ±80 km of stored route around an edit in a long section', () => {
    const route = meridianRoute([400]);
    const patch = wholeRoutePatch(route);
    const narrowed = narrowRoutePatchToEdit(patch, route, { fromM: 200_000, toM: 201_000, projected: false });

    expect(narrowed.start).toMatchObject({ kind: 'waypoint', distanceM: 119_000 });
    expect(narrowed.end).toMatchObject({ kind: 'waypoint', distanceM: 281_000 });
    expect(narrowed.start.lat).toBeCloseTo(route[119]!.lat, 9);
    // The real bounds stay in the window, for widenUnjoinedRoutePatchWindow.
    expect(narrowed.window).toEqual({
      start: patch.start,
      end: patch.end,
      fromM: 200_000,
      toM: 201_000,
      projected: false,
    });
  });

  it('keeps the real start when the window would spare less than 20 km before the edit', () => {
    const route = meridianRoute([400]);
    const patch = wholeRoutePatch(route);
    const narrowed = narrowRoutePatchToEdit(patch, route, { fromM: 90_000, toM: 90_500, projected: false });

    expect(narrowed.start).toBe(patch.start);
    expect(narrowed.end).toMatchObject({ kind: 'waypoint', distanceM: 171_000 });
  });

  it('returns the patch unchanged on a section too short to gain anything', () => {
    const route = meridianRoute([150]);
    const patch = wholeRoutePatch(route);
    const narrowed = narrowRoutePatchToEdit(patch, route, { fromM: 75_000, toM: 75_000, projected: false });

    expect(narrowed).toEqual({ start: patch.start, end: patch.end, via: patch.via });
    expect(narrowed.window).toBeUndefined();
  });

  it('ignores an edit projected outside the section of its neighbours', () => {
    const route = meridianRoute([400]);
    const patch = wholeRoutePatch(route);
    const narrowed = narrowRoutePatchToEdit(patch, route, { fromM: 420_000, toM: 421_000, projected: true });

    expect(narrowed.window).toBeUndefined();
  });

  it('does not trust a projected position the route passes again (out-and-back)', () => {
    const route = meridianRoute([200, -200]);
    const patch = wholeRoutePatch(route);
    const edit = { fromM: 100_000, toM: 100_000 };

    // Km 100 and km 300 are the same place: the projection may be on the other pass.
    expect(narrowRoutePatchToEdit(patch, route, { ...edit, projected: true }).window).toBeUndefined();
    // A position taken on the route itself is unambiguous.
    expect(narrowRoutePatchToEdit(patch, route, { ...edit, projected: false }).window).toBeDefined();
  });
});

describe('replaceRouteSegment', () => {
  it('splices the rerouted segment between the patch bounds and renumbers distances', () => {
    const base = meridianRoute([10]);
    const patch: ItineraryPendingRoutePatch = {
      start: { lat: base[3]!.lat, lon: base[3]!.lon, kind: 'waypoint', distanceM: 3000 },
      end: { lat: base[6]!.lat, lon: base[6]!.lon, kind: 'waypoint', distanceM: 6000 },
      via: [],
    };
    // Detour 1 km east between km 3 and km 6.
    const detour: RoutePoints = [
      { lat: base[3]!.lat, lon: 6 },
      { lat: base[4]!.lat, lon: 6.0127 },
      { lat: base[5]!.lat, lon: 6.0127 },
      { lat: base[6]!.lat, lon: 6 },
    ];

    const result = replaceRouteSegment(base, patch, detour);

    expect(result.slice(0, 4).map((point) => point.lat)).toEqual(base.slice(0, 4).map((point) => point.lat));
    expect(result.some((point) => point.lon > 6.01)).toBe(true);
    expect(result[result.length - 1]!.lat).toBeCloseTo(base[10]!.lat, 9);
    // Km 0–3, detour (its first point is the km 3 junction, kept once), km 7–10.
    expect(result).toHaveLength(4 + 3 + 4);
    for (let index = 1; index < result.length; index += 1) {
      expect(result[index]!.distanceM!).toBeGreaterThan(result[index - 1]!.distanceM!);
    }
    expect(result[result.length - 1]!.distanceM!).toBeGreaterThan(10_000);
  });

  it('returns the replacement as is when the base route is empty', () => {
    const replacement = meridianRoute([2]);
    expect(replaceRouteSegment([], wholeRoutePatch(replacement), replacement)).toBe(replacement);
  });
});

describe('appendRoutePoints', () => {
  it('shifts the extension by the base length and drops the shared junction point', () => {
    const base = meridianRoute([3]);
    const extension = meridianRoute([2], base[base.length - 1]!.lat);

    const result = appendRoutePoints(base, extension);

    expect(result).toHaveLength(base.length + extension.length - 1);
    expect(result.slice(base.length).map((point) => point.distanceM)).toEqual([4000, 5000]);
  });

  it('returns either side unchanged when the other is empty', () => {
    const route = meridianRoute([2]);
    expect(appendRoutePoints([], route)).toBe(route);
    expect(appendRoutePoints(route, [])).toBe(route);
  });
});

describe('routePointsEqual', () => {
  it('tolerates sub-metre noise but not a moved point', () => {
    const route = meridianRoute([2]);
    const noisy = route.map((point) => ({ ...point, distanceM: point.distanceM! + 0.2, lat: point.lat + 5e-7 }));
    const moved = route.map((point, index) => (index === 1 ? { ...point, lon: point.lon + 1e-4 } : point));

    expect(routePointsEqual(route, noisy)).toBe(true);
    expect(routePointsEqual(route, moved)).toBe(false);
    expect(routePointsEqual(route, route.slice(1))).toBe(false);
    expect(routePointsEqual(null, undefined)).toBe(true);
    expect(routePointsEqual(route, null)).toBe(false);
  });
});
