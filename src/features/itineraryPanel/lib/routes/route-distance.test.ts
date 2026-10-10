import { describe, expect, it } from 'vitest';

import { cumulativeRouteLengthsM, projectDistanceAlongRouteM, routeDistancesM } from './route-distance';

/** Trace plein nord : un point tous les ~111 m. */
const line = Array.from({ length: 11 }, (_, index) => ({ lat: 45 + index * 0.001, lon: 6 }));

describe('routeDistancesM : axe des distances d’un tracé', () => {
  it('reprend les distances portées par les points (trace d’origine, plus longue que la simplifiée)', () => {
    const points = line.map((point, index) => ({ ...point, distanceM: index * 120 }));
    expect(routeDistancesM(points)).toEqual(points.map((point) => point.distanceM));
    // Un POI au 5e point est au kilomètre de la prédiction, pas à vol d'oiseau.
    expect(projectDistanceAlongRouteM({ lat: 45.005, lon: 6.0001 }, points, routeDistancesM(points))).toBeCloseTo(600, 0);
  });

  it('distances absentes ou décroissantes : recalculées à vol d’oiseau', () => {
    const haversine = cumulativeRouteLengthsM(line);
    expect(routeDistancesM(line)).toEqual(haversine);
    const broken = line.map((point, index) => ({ ...point, distanceM: index === 4 ? 10 : index * 120 }));
    expect(routeDistancesM(broken)).toEqual(haversine);
    const partial = line.map((point, index) => (index === 3 ? point : { ...point, distanceM: index * 120 }));
    expect(routeDistancesM(partial)).toEqual(haversine);
  });
});
