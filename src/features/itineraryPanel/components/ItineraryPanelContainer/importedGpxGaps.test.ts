import { beforeEach, describe, expect, it, vi } from 'vitest';

import { haversineRouteDistanceM } from '../../lib/routes';

const resolveRouteRequest = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useItineraryBrouterRouting/resolveRouteRequest', () => ({ resolveRouteRequest }));

const { bridgeImportedGpxGaps, findImportedGpxGaps } = await import('./importedGpxGaps');

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;
const at = (km: number, eastM = 0) => ({
  lat: 44 + km / KM_PER_DEGREE,
  lon: 6 + eastM / (111_320 * Math.cos((44 * Math.PI) / 180)),
});

/** Trace dense (un point tous les 20 m) du km `fromKm` au km `toKm`. */
function track(fromKm: number, toKm: number) {
  const count = Math.round((toKm - fromKm) * 50);
  return Array.from({ length: count + 1 }, (_, index) => at(fromKm + index / 50));
}

function longestStepM(points: ReadonlyArray<{ lat: number; lon: number }>): number {
  let longest = 0;
  for (let index = 1; index < points.length; index += 1) {
    longest = Math.max(longest, haversineRouteDistanceM(points[index - 1]!, points[index]!));
  }
  return longest;
}

/** Faux BRouter : relie départ → via → arrivée par des points tous les 50 m (en ligne, comme une route droite). */
function fakeRouter() {
  resolveRouteRequest.mockImplementation(async ({ requestBase }) => {
    const stops = [requestBase.start, ...(requestBase.via ?? []), requestBase.end];
    const coordinates: [number, number][] = [];
    for (let index = 1; index < stops.length; index += 1) {
      const a = stops[index - 1];
      const b = stops[index];
      const steps = Math.max(1, Math.ceil(haversineRouteDistanceM(a, b) / 50));
      for (let step = index === 1 ? 0 : 1; step <= steps; step += 1) {
        coordinates.push([a.lon + ((b.lon - a.lon) * step) / steps, a.lat + ((b.lat - a.lat) * step) / steps]);
      }
    }
    return { route: { coordinates }, resolvedWarnings: [], resolved: {} };
  });
}

beforeEach(() => {
  resolveRouteRequest.mockReset();
});

describe('findImportedGpxGaps', () => {
  it('finds the jump between two track segments, not the continuous steps', () => {
    const first = track(0, 2);
    const second = track(10, 12);
    const points = [...first, ...second];

    expect(findImportedGpxGaps({ points, pointsKind: 'track', segmentStarts: [first.length] })).toEqual([first.length - 1]);
  });

  it('ignores a segment break that restarts where the previous one stopped (GPS pause)', () => {
    const points = track(0, 4);
    expect(findImportedGpxGaps({ points, pointsKind: 'track', segmentStarts: [100] })).toEqual([]);
  });

  it('finds a jump far beyond the track spacing inside a segment', () => {
    const points = [...track(0, 2), ...track(8, 10)];
    expect(findImportedGpxGaps({ points, pointsKind: 'track', segmentStarts: [] })).toEqual([100]);
  });

  it('treats a sparse route (<rtept>) as waypoints to join', () => {
    const points = [at(0), at(2), at(5), at(9)];
    expect(findImportedGpxGaps({ points, pointsKind: 'route', segmentStarts: [] })).toEqual([0, 1, 2]);
  });
});

describe('bridgeImportedGpxGaps', () => {
  it('routes the jump between segments: no straight line left', async () => {
    fakeRouter();
    const first = track(0, 2);
    const second = track(10, 12);

    const { route, bridged, unbridged } = await bridgeImportedGpxGaps({
      points: [...first, ...second],
      pointsKind: 'track',
      segmentStarts: [first.length],
    });

    expect(bridged).toBe(1);
    expect(unbridged).toBe(0);
    expect(resolveRouteRequest).toHaveBeenCalledTimes(1);
    expect(longestStepM(route.points)).toBeLessThan(60);
    const last = route.points[route.points.length - 1] as { distanceM?: number };
    expect(last.distanceM).toBeGreaterThan(11_900);
  });

  it('joins a sparse route through its points in one request', async () => {
    fakeRouter();
    const { route, bridged } = await bridgeImportedGpxGaps({
      points: [at(0), at(2), at(5), at(9)],
      pointsKind: 'route',
      segmentStarts: [],
    });

    expect(bridged).toBe(3);
    expect(resolveRouteRequest).toHaveBeenCalledTimes(1);
    expect(resolveRouteRequest.mock.calls[0]![0].requestBase.via).toHaveLength(2);
    expect(longestStepM(route.points)).toBeLessThan(60);
  });

  it('leaves a gap BRouter cannot join and reports it', async () => {
    resolveRouteRequest.mockRejectedValue(new Error('from-position not mapped in existing datafile'));
    const first = track(0, 2);
    const input = { points: [...first, ...track(10, 12)], pointsKind: 'track' as const, segmentStarts: [first.length] };

    const result = await bridgeImportedGpxGaps(input);

    expect(result).toEqual({ route: input, bridged: 0, unbridged: 1 });
  });

  it('does not route a GPX without discontinuity', async () => {
    const input = { points: track(0, 3), pointsKind: 'track' as const, segmentStarts: [] };
    expect(await bridgeImportedGpxGaps(input)).toEqual({ route: input, bridged: 0, unbridged: 0 });
    expect(resolveRouteRequest).not.toHaveBeenCalled();
  });
});
