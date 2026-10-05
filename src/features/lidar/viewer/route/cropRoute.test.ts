import { describe, expect, it } from 'vitest';

import { cropRouteAt } from './cropRoute';

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;
const at = (km: number, eastM = 0) => ({
  lat: 44 + km / KM_PER_DEGREE,
  lon: 6 + eastM / (111_320 * Math.cos((44 * Math.PI) / 180)),
  elevationM: 1_000 + km * 10,
});
const route = Array.from({ length: 11 }, (_, km) => at(km));

describe('cropRouteAt', () => {
  it('starts the route at a point placed on it, keeping what follows', () => {
    const cropped = cropRouteAt(route, at(3.5, 5), 'after')!;

    expect(cropped).toHaveLength(8);
    expect(cropped[0]!.lat).toBeCloseTo(at(3.5).lat, 9);
    expect(cropped[0]!.elevationM).toBeCloseTo(1_035, 6);
    expect(cropped[1]).toMatchObject({ lat: route[4]!.lat });
    // Distance équirectangulaire du viewer : ~0,1 % d'écart.
    expect(cropped[cropped.length - 1]!.distanceM).toBeCloseTo(6_500, -2);
  });

  it('ends the route at a point placed on it, keeping what precedes', () => {
    const cropped = cropRouteAt(route, at(7), 'before')!;

    expect(cropped).toHaveLength(8);
    expect(cropped[7]!.lat).toBeCloseTo(at(7).lat, 9);
  });

  it('refuses a point off the route (freehand placement instead)', () => {
    expect(cropRouteAt(route, at(5, 200), 'after')).toBeNull();
  });
});
