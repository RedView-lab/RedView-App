import { describe, expect, it } from 'vitest';

import type { ItineraryProject } from '../../types';

import { createDefaultItinerary, normalizeItineraryProject } from './defaultState';

function projectWithRoute(elevations: number[]): ItineraryProject {
  const itinerary = createDefaultItinerary();
  const points = elevations.map((elevationM, index) => ({ lat: 45 + index * 0.001, lon: 6, distanceM: index * 111, elevationM }));
  itinerary.gpxRoute = { name: null, points, source: 'gpx' };
  return { itineraries: [itinerary], activeItineraryId: itinerary.id } as unknown as ItineraryProject;
}

describe('normalizeItineraryProject : altitudes corrompues', () => {
  it('un tracé sain garde ses points (même tableau), à chaque normalisation', () => {
    const project = projectWithRoute([1000, 1010, 1020, 1030]);
    const points = project.itineraries[0].gpxRoute!.points;
    const once = normalizeItineraryProject(project);
    const twice = normalizeItineraryProject(once);
    expect(once.itineraries[0].gpxRoute!.points).toBe(points);
    expect(twice.itineraries[0].gpxRoute!.points).toBe(points);
  });

  it('un tracé aux altitudes corrompues est nettoyé, même après un tracé sain vérifié', () => {
    normalizeItineraryProject(projectWithRoute([1000, 1010, 1020, 1030]));
    const corrupted = projectWithRoute([1000, -32768, 1020, 1030]);
    const cleaned = normalizeItineraryProject(corrupted).itineraries[0].gpxRoute!.points;
    expect(cleaned).not.toBe(corrupted.itineraries[0].gpxRoute!.points);
    expect(cleaned.every((point) => point.elevationM !== -32768)).toBe(true);
    // Toujours nettoyé à la normalisation suivante du même tracé (jamais retenu comme sain).
    const again = normalizeItineraryProject(corrupted).itineraries[0].gpxRoute!.points;
    expect(again.every((point) => point.elevationM !== -32768)).toBe(true);
  });
});
