import { describe, expect, it } from 'vitest';

import type { ItineraryProject } from '../../types';

import { createDefaultItinerary, normalizeItineraryProject } from './defaultState';
import { PANEL_POI_ROWS } from './poiRows';

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

describe('normalizeItineraryProject : lignes POI', () => {
  function projectWithPoi(poi: Record<string, unknown>): ItineraryProject {
    const itinerary = createDefaultItinerary();
    (itinerary as { poi: unknown }).poi = poi;
    return { itineraries: [itinerary], activeItineraryId: itinerary.id } as unknown as ItineraryProject;
  }

  it("un nouvel itinéraire cherche les cimetières à 100 m (centroïde de l'enclos)", () => {
    expect(createDefaultItinerary().poi.cemeteries).toEqual({ enabled: true, distanceM: 100 });
    expect(PANEL_POI_ROWS.map((row) => row.key)).toContain('cemeteries');
  });

  it('un ancien projet sans la ligne la reçoit avec son propre défaut, ses réglages intacts', () => {
    const poi = normalizeItineraryProject(projectWithPoi({ fountains: { enabled: false, distanceM: 60 } })).itineraries[0].poi;
    expect(poi.fountains).toEqual({ enabled: false, distanceM: 60 });
    expect(poi.cemeteries).toEqual({ enabled: true, distanceM: 100 });
  });

  it('un ancien projet resté à 40 m partout passe encore aux nouveaux défauts', () => {
    const poi = normalizeItineraryProject(projectWithPoi({
      fountains: { enabled: true, distanceM: 40 },
      toilets: { enabled: true, distanceM: 40 },
    })).itineraries[0].poi;
    expect(poi.fountains.distanceM).toBe(20);
    expect(poi.toilets.distanceM).toBe(20);
    expect(poi.cemeteries.distanceM).toBe(100);
  });
});
