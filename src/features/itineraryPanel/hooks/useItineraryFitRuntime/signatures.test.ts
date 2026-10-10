import { describe, expect, it } from 'vitest';

import { CYCLING_ENGINE_VERSION } from '@/features/fitPredictor/engine/version';
import { createDefaultRhythmState } from '../../lib/project/defaultState';
import type { Itinerary } from '../../types';

import { buildPredictionStamp, buildRouteSignature, storedPredictionStillValid } from './signatures';

type GpxRoute = NonNullable<Itinerary['gpxRoute']>;
type RoutePoint = GpxRoute['points'][number];

/** Tracé de 10 km vers le nord, un point tous les 100 m, altitude 500 m, asphalte. */
function route(map: (point: RoutePoint, index: number) => RoutePoint = (point) => point): GpxRoute {
  const points = Array.from({ length: 101 }, (_, index): RoutePoint => ({
    lat: 45 + (index * 100) / 111_195,
    lon: 6,
    distanceM: index * 100,
    elevationM: 500,
    surface: 'asphalt',
  })).map(map);
  return { name: null, points, source: 'brouter' };
}

function itinerary(gpxRoute: GpxRoute, extra: Partial<Itinerary> = {}): Itinerary {
  return { id: 'it-1', name: 'Col', discipline: 'bike', gpxRoute, timeline: [], ...extra } as unknown as Itinerary;
}

describe('buildRouteSignature', () => {
  it('is the same for the same route content in a new array', () => {
    expect(buildRouteSignature(route())).toBe(buildRouteSignature(route()));
  });

  it('changes when the altitudes are refined on the same geometry (D2-1)', () => {
    const climb = route((point, index) => (index > 30 && index < 70 ? { ...point, elevationM: 500 + (index - 30) * 20 } : point));
    expect(buildRouteSignature(climb)).not.toBe(buildRouteSignature(route()));
  });

  it('changes when the surfaces are analysed (gravel, roughness, way context)', () => {
    const base = buildRouteSignature(route());
    expect(buildRouteSignature(route((point) => ({ ...point, surface: 'gravel' })))).not.toBe(base);
    expect(buildRouteSignature(route((point) => ({ ...point, roughness: 3 })))).not.toBe(base);
    expect(buildRouteSignature(route((point) => ({ ...point, wayCode: 4 })))).not.toBe(base);
  });

  it('changes when the middle of the route moves with the same ends, count and length', () => {
    const shifted = route((point, index) => (index > 0 && index < 100 ? { ...point, lon: 6.0005 } : point));
    expect(buildRouteSignature(shifted)).not.toBe(buildRouteSignature(route()));
  });

  it('is the same when the original points are the route itself, aliased or reloaded (4c relecture)', () => {
    const base = route();
    const aliased = { ...base, originalPoints: base.points };
    // Après un rechargement (JSON) ou une matérialisation collab : même contenu, autre tableau.
    const reloaded = JSON.parse(JSON.stringify(aliased)) as typeof aliased;
    expect(reloaded.originalPoints).not.toBe(reloaded.points);
    expect(buildRouteSignature(reloaded)).toBe(buildRouteSignature(aliased));
    expect(buildRouteSignature(aliased)).toBe(buildRouteSignature(base));
  });

  it('includes the original points of an imported GPX that the engine reads', () => {
    const base = route();
    const dense = (elevationM: number) => Array.from({ length: 1_001 }, (_, index) => ({
      lat: 45 + (index * 10) / 111_195,
      lon: 6,
      elevationM,
    }));
    expect(buildRouteSignature({ ...base, originalPoints: dense(500) }))
      .not.toBe(buildRouteSignature({ ...base, originalPoints: dense(800) }));
  });
});

describe('storedPredictionStillValid', () => {
  const prediction = { total_distance_m: 10_000, discipline: 'bike', engine_version: CYCLING_ENGINE_VERSION } as unknown as NonNullable<Itinerary['prediction']>;

  it('keeps a prediction whose stamp matches its inputs', () => {
    const current = itinerary(route(), { prediction });
    current.predictionInputsKey = buildPredictionStamp(current);
    expect(storedPredictionStillValid(current, 'bike', { firstPass: false })).toBe(true);
  });

  it('recomputes a stamped prediction whose inputs changed, even at the first opening (D2-2)', () => {
    const before = itinerary(route(), { prediction });
    const stamp = buildPredictionStamp(before);
    // Rythme changé puis onglet fermé avant le recalcul : distance identique.
    const after = itinerary(route(), { prediction, predictionInputsKey: stamp, rhythm: { ...createDefaultRhythmState(), practiceLevel: 'expert' } });
    expect(storedPredictionStillValid(after, 'bike', { firstPass: true })).toBe(false);
  });

  it('keeps an unstamped legacy prediction at the first opening when distance and discipline match', () => {
    const legacy = itinerary(route(), { prediction });
    expect(storedPredictionStillValid(legacy, 'bike', { firstPass: true })).toBe(true);
    expect(storedPredictionStillValid(legacy, 'bike', { firstPass: false })).toBe(false);
    const longer = itinerary(route(), { prediction: { ...prediction, total_distance_m: 12_000 } });
    expect(storedPredictionStillValid(longer, 'bike', { firstPass: true })).toBe(false);
  });
});
