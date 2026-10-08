import { describe, expect, it } from 'vitest';

import { effectiveSearchKm as proxyEffectiveSearchKm, resolvePass1Coefficient } from '../../../../../../api/_lib/brouter-search.ts';
import type { BrouterPoint } from '../types';
import {
  DEFAULT_SEARCH_COST_SCALE,
  effectiveSearchKm,
  requestBeelineKm,
  resolveSearchCoefficient,
  searchWeightForKm,
} from './searchCoefficient';

/** Points le long d'un méridien, espacés de `segmentsKm` (km de grand cercle sur la sphère de 6 371 km). */
function meridianRoute(segmentsKm: number[], startLat = 43): BrouterPoint[] {
  const kmPerDegree = (12_742 * Math.PI) / 360;
  const points: BrouterPoint[] = [{ lat: startLat, lon: 6 }];
  for (const km of segmentsKm) {
    points.push({ lat: points[points.length - 1]!.lat + km / kmPerDegree, lon: 6 });
  }
  return points;
}

const toLonlats = (points: BrouterPoint[]) => points.map(({ lon, lat }) => `${lon},${lat}`).join('|');

describe('searchWeightForKm', () => {
  it('interpolates between distance steps and clamps at both ends', () => {
    expect(searchWeightForKm(0)).toBe(0.8);
    expect(searchWeightForKm(25)).toBeCloseTo(0.825, 10);
    expect(searchWeightForKm(100)).toBe(1.1);
    expect(searchWeightForKm(1000)).toBe(2);
    expect(searchWeightForKm(5000)).toBe(2);
  });

  it('never decreases with distance', () => {
    let previous = 0;
    for (let km = 0; km <= 1500; km += 5) {
      const weight = searchWeightForKm(km);
      expect(weight).toBeGreaterThanOrEqual(previous);
      previous = weight;
    }
  });
});

describe('effectiveSearchKm', () => {
  it('equals the length of a route without via points', () => {
    expect(effectiveSearchKm(meridianRoute([120]))).toBeCloseTo(120, 6);
  });

  it('is √(Σ Lᵢ²) for a route cut into legs', () => {
    const route = meridianRoute([30, 40]);
    expect(effectiveSearchKm(route)).toBeCloseTo(50, 6);
    expect(requestBeelineKm(route)).toBeCloseTo(70, 6);
  });
});

describe('resolveSearchCoefficient', () => {
  it('multiplies the profile cost scale by the distance weight', () => {
    expect(resolveSearchCoefficient(meridianRoute([100]), 2)).toBe(2.2);
  });

  it('falls back to the stock cost scale on an invalid scale', () => {
    const route = meridianRoute([100]);
    expect(resolveSearchCoefficient(route, Number.NaN)).toBe(resolveSearchCoefficient(route, DEFAULT_SEARCH_COST_SCALE));
    expect(resolveSearchCoefficient(route, -1)).toBe(resolveSearchCoefficient(route, DEFAULT_SEARCH_COST_SCALE));
  });

  it('uses an explicit weight (coarse search) and stays within [0.75, 12]', () => {
    expect(resolveSearchCoefficient(meridianRoute([10]), 1.5, 2.4)).toBe(3.6);
    expect(resolveSearchCoefficient(meridianRoute([10]), 0.1, 0.5)).toBe(0.75);
    expect(resolveSearchCoefficient(meridianRoute([10]), 40, 4)).toBe(12);
  });
});

// api/_lib/brouter-search.ts recalcule le coefficient quand le client n'en envoie
// pas : les deux côtés doivent garder les mêmes paliers de distance.
describe('client / BRouter proxy parity', () => {
  const routes: Array<[string, BrouterPoint[]]> = [
    ['5 km', meridianRoute([5])],
    ['50 km', meridianRoute([50])],
    ['130 km', meridianRoute([130])],
    ['300 km in 3 legs', meridianRoute([100, 120, 80])],
    ['480 km', meridianRoute([480])],
    ['800 km in 2 legs', meridianRoute([500, 300])],
    ['1 400 km', meridianRoute([1400], 40)],
  ];

  it.each(routes)('same effective distance for %s', (_label, route) => {
    expect(proxyEffectiveSearchKm(toLonlats(route))).toBeCloseTo(effectiveSearchKm(route), 6);
  });

  it.each(routes)('same default coefficient for %s', (_label, route) => {
    expect(resolvePass1Coefficient(toLonlats(route), null)).toBe(resolveSearchCoefficient(route));
  });

  it('floors a requested coefficient at 0.9 × the distance weight', () => {
    const route = meridianRoute([1000]);
    expect(resolvePass1Coefficient(toLonlats(route), '0.5')).toBe(1.8);
    expect(resolvePass1Coefficient(toLonlats(route), '3.25')).toBe(3.25);
  });

  it('caps a requested coefficient at 12 and ignores garbage', () => {
    const lonlats = toLonlats(meridianRoute([100]));
    expect(resolvePass1Coefficient(lonlats, '50')).toBe(12);
    expect(resolvePass1Coefficient(lonlats, 'abc')).toBe(resolvePass1Coefficient(lonlats, null));
  });
});
