import { describe, expect, it } from 'vitest';

import { RedviewFileError } from './errors';
import { sanitizeImportedProject } from './sanitizeProject';

function projectWithPoints(points: unknown[]) {
  return {
    name: 'Projet',
    itineraries: [{ id: 'it-1', timeline: [], gpxRoute: { name: null, points } }],
  };
}

describe('sanitizeImportedProject — points de tracé', () => {
  it('drops non-numeric elevation / distance / gradient but keeps the point and valid values', () => {
    const project = sanitizeImportedProject(projectWithPoints([
      { lat: 45, lon: 6, elevationM: 'abc', distanceM: 0 },
      { lat: 45.01, lon: 6, elevationM: 1200.5, distanceM: { x: 1 }, gradientPct: '5' },
      { lat: 45.02, lon: 6, elevationM: null, distanceM: 2224 },
    ]));
    const points = project.itineraries[0]!.gpxRoute!.points;
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ lat: 45, lon: 6, distanceM: 0 });
    expect(points[1]).toEqual({ lat: 45.01, lon: 6, elevationM: 1200.5 });
    expect(points[2]).toEqual({ lat: 45.02, lon: 6, elevationM: null, distanceM: 2224 });
  });

  it('refuses a point with invalid coordinates', () => {
    expect(() => sanitizeImportedProject(projectWithPoints([{ lat: 95, lon: 6 }]))).toThrow(RedviewFileError);
    expect(() => sanitizeImportedProject(projectWithPoints([{ lat: '45', lon: 6 }]))).toThrow(RedviewFileError);
  });
});
