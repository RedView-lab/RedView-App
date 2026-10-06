import { describe, expect, it } from 'vitest';

import type { Itinerary, PoiCategory } from '@/features/itineraryPanel/types';

import { buildItineraryFitCourse } from './exportFit';

const CATEGORIES: PoiCategory[] = [
  'fountains', 'toilets', 'supermarkets', 'gasStations', 'bakeries', 'fastFood', 'cafes', 'bars',
  'restaurants', 'bikeShops', 'hotels', 'refuges', 'passes', 'health', 'transport',
];

function itineraryWithEveryPoiCategory(): Itinerary {
  const points = Array.from({ length: 400 }, (_, i) => ({
    lat: 45.9 + i * 0.0005,
    lon: 6.87,
    elevationM: 1000 + i,
    distanceM: i * 55.6,
  }));
  const at = (i: number) => points[i]!;
  return {
    id: 'it',
    name: 'Tour du Mont-Blanc',
    discipline: 'road',
    gpxRoute: { name: 'Tour du Mont-Blanc', points },
    poiFeatures: [],
    timeline: [
      { id: 'start', label: 'Départ', kind: 'start', lat: at(0).lat, lon: at(0).lon, distanceKm: 0 },
      ...CATEGORIES.map((poiCategory, k) => {
        const p = at(20 + k * 20);
        return { id: `poi-${k}`, label: poiCategory, kind: 'poi', poiCategory, osmId: 100 + k, lat: p.lat, lon: p.lon, distanceKm: p.distanceM / 1000, visible: true, favorite: true };
      }),
      { id: 'end', label: 'Arrivée', kind: 'end', lat: at(399).lat, lon: at(399).lon, distanceKm: at(399).distanceM / 1000 },
    ],
  } as unknown as Itinerary;
}

describe('buildItineraryFitCourse', () => {
  it('exports a course point for every POI category (valid FIT course point types)', () => {
    // « health » était exporté en « first_aid », absent du profil FIT : l'export échouait.
    const bytes = buildItineraryFitCourse(itineraryWithEveryPoiCategory());
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('.FIT');
    expect(bytes.length).toBeGreaterThan(400 * 17);
  });
});
