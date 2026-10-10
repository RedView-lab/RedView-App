import { describe, expect, it } from 'vitest';

import type { PoiFeature } from '@/features/poi/types';
import { createDefaultItinerary } from '../../lib/project';
import type { Itinerary, ItineraryProject } from '../../types';

import { applyCorridorComplete } from './poiCorridorMutations';

const KM_PER_DEGREE = (12_742 * Math.PI) / 360;
const at = (km: number, eastM = 0) => ({
  lat: 44 + km / KM_PER_DEGREE,
  lon: 6 + eastM / (111_320 * Math.cos((44 * Math.PI) / 180)),
});

function feature(id: number, category: PoiFeature['category'], km: number, name: string, extra: Partial<PoiFeature> = {}): PoiFeature {
  return { id, category, name, tags: {}, ...at(km, 80), ...extra };
}

function project(timelineRows: Itinerary['timeline'], poiFeatures: PoiFeature[]): ItineraryProject {
  const itinerary = createDefaultItinerary();
  const points = Array.from({ length: 41 }, (_, index) => ({ ...at(index), distanceM: index * 1_000 }));
  itinerary.gpxRoute = { name: null, points, source: 'brouter' };
  itinerary.timeline = [
    { id: 'start', kind: 'start', label: 'A', distanceKm: 0, ...at(0) },
    ...timelineRows,
    { id: 'end', kind: 'end', label: 'B', distanceKm: 40, ...at(40) },
  ];
  itinerary.poiFeatures = poiFeatures;
  return { itineraries: [itinerary], activeItineraryId: itinerary.id } as unknown as ItineraryProject;
}

const hotel = feature(1, 'hotel', 20, 'Hôtel du Col', { favorite: true, pauseDurationMin: 360 });
const bakery = feature(2, 'bakery', 10, 'Boulangerie');
const water = feature(3, 'drinking_water', 30, 'Fontaine');

const hotelRow: Itinerary['timeline'][number] = {
  id: 'poi-1', kind: 'poi', label: 'Nuit ici (réservé)', labelEdited: true, distanceKm: 20, ...at(20, 80),
  poiCategory: 'hotels', osmId: 1, favorite: true, favoriteSource: 'manual', durationMin: 360, visible: true,
};
const waterRow: Itinerary['timeline'][number] = {
  id: 'poi-3', kind: 'poi', label: 'Fontaine 7-19', labelEdited: true, distanceKm: 30, ...at(30, 80),
  poiCategory: 'fountains', osmId: 3, visible: true,
};
const plainRow: Itinerary['timeline'][number] = {
  id: 'poi-4', kind: 'poi', label: 'Café', distanceKm: 5, ...at(5, 80), poiCategory: 'cafes', osmId: 4, visible: true,
};

function poiRows(next: ItineraryProject) {
  return next.itineraries[0]!.timeline.filter((row) => row.kind === 'poi');
}

describe('applyCorridorComplete', () => {
  it('keeps a favourite with its pause and typed name when a new search no longer returns it (E1-1)', () => {
    const before = project([hotelRow, waterRow, plainRow], [hotel, water, feature(4, 'cafe', 5, 'Café')]);

    const next = applyCorridorComplete(before, before.itineraries[0]!.id, [bakery], before.itineraries[0]!.gpxRoute!.points);

    const rows = poiRows(next);
    expect(rows.map((row) => [row.label, row.favorite ?? null, row.durationMin ?? null])).toEqual([
      ['Boulangerie', null, null],
      ['Nuit ici (réservé)', true, 360],
      ['Fontaine 7-19', null, null],
    ]);
    // Le favori reste sur la carte (poiFeatures) ; la ligne automatique non retrouvée disparaît.
    expect(next.itineraries[0]!.poiFeatures!.map((f) => f.id).sort()).toEqual([1, 2, 3]);
    // Rangées dans l'ordre du tracé, avant l'arrivée.
    expect(next.itineraries[0]!.timeline.map((row) => row.id).at(-1)).toBe('end');
  });

  it('keeps them after an empty search too', () => {
    const before = project([hotelRow, plainRow], [hotel]);

    const next = applyCorridorComplete(before, before.itineraries[0]!.id, [], before.itineraries[0]!.gpxRoute!.points);

    expect(poiRows(next).map((row) => row.osmId)).toEqual([1]);
    expect(poiRows(next)[0]).toMatchObject({ favorite: true, durationMin: 360, label: 'Nuit ici (réservé)', distanceKm: 20 });
  });

  it('drops an old auto-sort favourite the search no longer returns', () => {
    const autoRow = { ...plainRow, favorite: true, favoriteSource: 'auto' as const };
    const before = project([autoRow], []);

    const next = applyCorridorComplete(before, before.itineraries[0]!.id, [bakery], before.itineraries[0]!.gpxRoute!.points);

    expect(poiRows(next).map((row) => row.osmId)).toEqual([2]);
  });
});
