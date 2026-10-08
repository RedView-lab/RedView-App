import { describe, expect, it } from 'vitest';

import { isRouteSeamError } from '../../routes/route-continuity';
import type { BrouterRoute } from '../types';

import { concatBrouterRoutes } from './multi-leg';

function leg(coordinates: [number, number][]): BrouterRoute {
  return {
    coordinates,
    distanceM: 1_000,
    durationS: 100,
    ascentM: 0,
    descentM: 0,
    raw: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} }] },
  } as unknown as BrouterRoute;
}

describe('concatBrouterRoutes', () => {
  it('joins consecutive legs on their shared junction point (kept once)', () => {
    const route = concatBrouterRoutes([
      leg([[6, 44], [6, 44.01]]),
      leg([[6, 44.01], [6, 44.02]]),
    ]);

    expect(route.coordinates).toEqual([[6, 44], [6, 44.01], [6, 44.02]]);
    expect(route.distanceM).toBe(2_000);
  });

  it('refuses legs that do not meet: no straight line between them', () => {
    let error: unknown = null;
    try {
      // Jonction déplacée d'environ 550 m entre les deux tronçons (réparation d'île d'un seul côté).
      concatBrouterRoutes([leg([[6, 44], [6, 44.01]]), leg([[6, 44.015], [6, 44.02]])]);
    } catch (reason) {
      error = reason;
    }

    expect(isRouteSeamError(error)).toBe(true);
  });
});
