import { describe, expect, it } from 'vitest';

import { haversineRouteDistanceM } from '../../lib/routes';
import type { ItineraryPendingRoutePatch } from '../../types/itinerary';

import {
  anchorRoutePatchBound,
  cropRoutePoints,
  planRouteSplice,
} from './routeSplice';
import {
  appendRoutePoints,
  replaceRouteSegment,
  routePointsEqual,
} from './routeSegments';
import {
  narrowRoutePatchToEdit,
  widenUnjoinedRoutePatchWindow,
} from './routePatchWindow';
import type { RoutePoints } from './types';

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;

/** Plus long pas du tracé (m) : une ligne droite recollée y apparaît. */
function longestStepM(points: ReadonlyArray<{ lat: number; lon: number }>): number {
  let longest = 0;
  for (let index = 1; index < points.length; index += 1) {
    longest = Math.max(longest, haversineRouteDistanceM(points[index - 1]!, points[index]!));
  }
  return longest;
}

/** Tronçon parallèle au méridien, décalé de `offsetM` vers l'est, entre les km `fromKm` et `toKm`. */
function parallelPiece(base: RoutePoints, fromKm: number, toKm: number, offsetM: number): RoutePoints {
  const lonOffset = offsetM / (111_320 * Math.cos((base[fromKm]!.lat * Math.PI) / 180));
  return base.slice(fromKm, toKm + 1).map((point) => ({ lat: point.lat, lon: point.lon + lonOffset }));
}

/**
 * Tracé le long du méridien 6°E, un point par km. `legsKm` alternent nord
 * (positif) et sud (négatif) : `[200, -200]` est un aller-retour.
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
  it('reroutes only ±12 km of stored route around an edit in a long section', () => {
    const route = meridianRoute([400]);
    const patch = wholeRoutePatch(route);
    const narrowed = narrowRoutePatchToEdit(patch, route, { fromM: 200_000, toM: 201_000, projected: false });

    expect(narrowed.start).toMatchObject({ kind: 'waypoint', distanceM: 187_000 });
    expect(narrowed.end).toMatchObject({ kind: 'waypoint', distanceM: 213_000 });
    expect(narrowed.start.lat).toBeCloseTo(route[187]!.lat, 9);
    // Les vraies bornes restent dans la fenêtre, pour widenUnjoinedRoutePatchWindow.
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
    const narrowed = narrowRoutePatchToEdit(patch, route, { fromM: 30_000, toM: 30_500, projected: false });

    expect(narrowed.start).toBe(patch.start);
    expect(narrowed.end).toMatchObject({ kind: 'waypoint', distanceM: 43_000 });
  });

  it('returns the patch unchanged on a section too short to gain anything', () => {
    const route = meridianRoute([50]);
    const patch = wholeRoutePatch(route);
    const narrowed = narrowRoutePatchToEdit(patch, route, { fromM: 25_000, toM: 25_000, projected: false });

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

    // Le km 100 et le km 300 sont au même endroit : la projection peut tomber sur l'autre passage.
    expect(narrowRoutePatchToEdit(patch, route, { ...edit, projected: true }).window).toBeUndefined();
    // Une position prise sur le tracé lui-même est sans ambiguïté.
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
    // Détour de 1 km vers l'est entre le km 3 et le km 6.
    const detour: RoutePoints = [
      { lat: base[3]!.lat, lon: 6 },
      { lat: base[4]!.lat, lon: 6.0127 },
      { lat: base[5]!.lat, lon: 6.0127 },
      { lat: base[6]!.lat, lon: 6 },
    ];

    const result = replaceRouteSegment(base, patch, detour)!;

    expect(result).not.toBeNull();
    expect(result.slice(0, 4).map((point) => point.lat)).toEqual(base.slice(0, 4).map((point) => point.lat));
    expect(result.some((point) => point.lon > 6.01)).toBe(true);
    expect(result[result.length - 1]!.lat).toBeCloseTo(base[10]!.lat, 9);
    // Km 0–3, détour (son premier point est la jonction du km 3, gardée une fois), km 7–10.
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

  it('drops the old start when the start moved (« Démarrer ici »): no straight line from it', () => {
    const base = meridianRoute([100]);
    // Nouveau départ au km 30, routé pour rejoindre le tracé stocké au km 60.
    const replacement = base.slice(30, 61).map((point) => ({ lat: point.lat, lon: point.lon }));
    const patch: ItineraryPendingRoutePatch = {
      start: { lat: base[30]!.lat, lon: base[30]!.lon, kind: 'start' },
      end: { lat: base[60]!.lat, lon: base[60]!.lon, kind: 'waypoint', distanceM: 60_000 },
      via: [],
    };

    const result = replaceRouteSegment(base, patch, replacement)!;

    expect(result[0]!.lat).toBeCloseTo(base[30]!.lat, 9);
    expect(result[result.length - 1]!.lat).toBeCloseTo(base[100]!.lat, 9);
    expect(longestStepM(result)).toBeLessThan(1_001);
    expect(result[result.length - 1]!.distanceM!).toBeCloseTo(70_000, -2);
  });

  it('drops the old end when the end moved (« Finir ici »): no straight line to it', () => {
    const base = meridianRoute([100]);
    const replacement = base.slice(20, 51).map((point) => ({ lat: point.lat, lon: point.lon }));
    const patch: ItineraryPendingRoutePatch = {
      start: { lat: base[20]!.lat, lon: base[20]!.lon, kind: 'waypoint', distanceM: 20_000 },
      end: { lat: base[50]!.lat, lon: base[50]!.lon, kind: 'end' },
      via: [],
    };

    const result = replaceRouteSegment(base, patch, replacement)!;

    expect(result[0]!.lat).toBeCloseTo(base[0]!.lat, 9);
    expect(result[result.length - 1]!.lat).toBeCloseTo(base[50]!.lat, 9);
    expect(longestStepM(result)).toBeLessThan(1_001);
  });

  it('refuses a routed piece that does not join the stored route at an intermediate bound', () => {
    const base = meridianRoute([20]);
    // Part 300 m à l'est du tracé stocké (étape accrochée loin d'une trace GPX) et n'y revient jamais.
    const replacement = parallelPiece(base, 5, 15, 300);
    const patch: ItineraryPendingRoutePatch = {
      start: { lat: base[5]!.lat, lon: base[5]!.lon, kind: 'waypoint', distanceM: 5_000 },
      end: { lat: base[15]!.lat, lon: base[15]!.lon, kind: 'end' },
      via: [],
    };

    expect(replaceRouteSegment(base, patch, replacement)).toBeNull();
    expect(planRouteSplice(base, patch, replacement)).toMatchObject({ ok: false, side: 'start' });
  });

  it('joins where the routed piece rejoins the stored route, a few points after its snapped start', () => {
    const base = meridianRoute([20]);
    const offRoad = parallelPiece(base, 5, 5, 120)[0]!;
    // Accroché 120 m à l'est, puis de retour sur le tracé stocké à partir du km 6.
    const replacement = [offRoad, ...base.slice(6, 16).map((point) => ({ lat: point.lat, lon: point.lon }))];
    const patch: ItineraryPendingRoutePatch = {
      start: { lat: base[5]!.lat, lon: base[5]!.lon, kind: 'waypoint', distanceM: 5_000 },
      end: { lat: base[15]!.lat, lon: base[15]!.lon, kind: 'waypoint', distanceM: 15_000 },
      via: [],
    };

    const plan = planRouteSplice(base, patch, replacement);
    expect(plan).toMatchObject({ ok: true, firstIndex: 1 });
    const result = replaceRouteSegment(base, patch, replacement)!;
    expect(result.some((point) => point.lon > 6.001)).toBe(false);
    expect(longestStepM(result)).toBeLessThan(1_001);
  });

  it('refuses bounds resolved on two different passes (would duplicate the route)', () => {
    const base = meridianRoute([200, -200]);
    const replacement = base.slice(100, 111).map((point) => ({ lat: point.lat, lon: point.lon }));
    const patch: ItineraryPendingRoutePatch = {
      // Départ indiqué sur le retour (km 300 = même endroit que le km 100), arrivée sur l'aller.
      start: { lat: base[100]!.lat, lon: base[100]!.lon, kind: 'waypoint', distanceM: 300_000 },
      end: { lat: base[110]!.lat, lon: base[110]!.lon, kind: 'waypoint', distanceM: 110_000 },
      via: [],
    };

    expect(replaceRouteSegment(base, patch, replacement)).toBeNull();
  });
});

describe('anchorRoutePatchBound', () => {
  it('moves an intermediate bound onto the stored route, keeps start / end rows as they are', () => {
    const base = meridianRoute([20]);
    const hotel = parallelPiece(base, 8, 8, 900)[0]!;

    const anchored = anchorRoutePatchBound({ ...hotel, kind: 'waypoint', distanceM: 8_000 }, base);
    expect(haversineRouteDistanceM(anchored, base[8]!)).toBeLessThan(1);
    expect(anchorRoutePatchBound({ ...hotel, kind: 'start' }, base)).toEqual({ lat: hotel.lat, lon: hotel.lon });
  });
});

describe('widenUnjoinedRoutePatchWindow', () => {
  it('widens a provisional bound whose seam failed even if the route follows the old one', () => {
    const route = meridianRoute([400]);
    const narrowed = narrowRoutePatchToEdit(wholeRoutePatch(route), route, {
      fromM: 200_000,
      toM: 201_000,
      projected: false,
    });
    const along = route.slice(187, 214).map((point): [number, number] => [point.lon, point.lat]);

    expect(widenUnjoinedRoutePatchWindow(narrowed, route, along)).toBeNull();
    const widened = widenUnjoinedRoutePatchWindow(narrowed, route, along, { start: true });
    // Étape suivante : 80 km avant l'édition ; l'arrivée rejointe garde sa borne.
    expect(widened?.start).toMatchObject({ kind: 'waypoint', distanceM: 119_000 });
    expect(widened?.end).toEqual(narrowed.end);
    // Puis 200 km avant le km 200 : le vrai départ.
    const widenedAgain = widenUnjoinedRoutePatchWindow(widened!, route, along, { start: true });
    expect(widenedAgain?.start).toEqual(narrowed.window!.start);
  });
});

describe('cropRoutePoints', () => {
  it('keeps what follows a new start placed on the route, cut exactly there', () => {
    const base = meridianRoute([10]);
    const at = { lat: (base[3]!.lat + base[4]!.lat) / 2, lon: 6 };

    const cropped = cropRoutePoints(base, at, 'after', { toleranceM: 15 })!;

    expect(cropped.cutM).toBeCloseTo(3_500, -1);
    expect(cropped.points[0]!.lat).toBeCloseTo(at.lat, 9);
    expect(cropped.points[0]!.distanceM).toBe(0);
    expect(cropped.points[cropped.points.length - 1]!.lat).toBeCloseTo(base[10]!.lat, 9);
    expect(cropped.points[cropped.points.length - 1]!.distanceM!).toBeCloseTo(6_500, -1);
  });

  it('keeps what precedes a new end placed on the route', () => {
    const base = meridianRoute([10]);
    const cropped = cropRoutePoints(base, base[7]!, 'before', { toleranceM: 15 })!;

    expect(cropped.points).toHaveLength(8);
    expect(cropped.points[7]!.lat).toBeCloseTo(base[7]!.lat, 9);
  });

  it('refuses a point off the route or a crop that would leave nothing', () => {
    const base = meridianRoute([10]);
    const offRoute = parallelPiece(base, 5, 5, 100)[0]!;

    expect(cropRoutePoints(base, offRoute, 'after', { toleranceM: 15 })).toBeNull();
    expect(cropRoutePoints(base, offRoute, 'after', { toleranceM: 150 })).not.toBeNull();
    expect(cropRoutePoints(base, base[10]!, 'after', { toleranceM: 15 })).toBeNull();
  });

  it('cuts at the pass given by the hint on an out-and-back', () => {
    const base = meridianRoute([50, -50]);
    // Le km 20 et le km 80 sont au même endroit.
    const cropped = cropRoutePoints(base, base[20]!, 'before', { toleranceM: 15, hintM: 80_000 })!;

    expect(cropped.cutM).toBeCloseTo(80_000, -1);
  });
});

describe('appendRoutePoints', () => {
  it('shifts the extension by the base length and drops the shared junction point', () => {
    const base = meridianRoute([3]);
    const extension = meridianRoute([2], base[base.length - 1]!.lat);

    const result = appendRoutePoints(base, extension)!;

    expect(result).toHaveLength(base.length + extension.length - 1);
    expect(result.slice(base.length).map((point) => point.distanceM)).toEqual([4000, 5000]);
  });

  it('refuses an extension that does not start at the end of the route', () => {
    const base = meridianRoute([3]);
    const extension = meridianRoute([2], base[base.length - 1]!.lat + 0.01);

    expect(appendRoutePoints(base, extension)).toBeNull();
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
