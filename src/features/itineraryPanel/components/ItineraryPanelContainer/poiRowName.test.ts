import { describe, expect, it } from 'vitest';

import type { PoiFeature } from '@/features/poi/types';
import { createDefaultItinerary, createDefaultProject } from '../../lib/project';
import type { Itinerary, ItineraryProject } from '../../types';

import { applyCorridorComplete } from './poiCorridorMutations';
import { renamePoiTimelineRow } from './poiRowName';

const bakery: PoiFeature = { id: 101, lat: 44.1, lon: 6, category: 'bakery', name: 'La Mie Câline', tags: {} };
const fountain: PoiFeature = { id: 102, lat: 44.2, lon: 6, category: 'fountain', name: null, tags: {} };

function itinerary(): Itinerary {
  const it = createDefaultItinerary();
  it.gpxRoute = {
    name: null,
    points: Array.from({ length: 51 }, (_, index) => ({ lat: 44 + index * 0.009, lon: 6, distanceM: index * 1000 })),
  };
  it.poiFeatures = [bakery, fountain].map((feature) => ({ ...feature }));
  it.timeline = [
    { id: 'start', kind: 'start', label: 'A', distanceKm: 0, lat: 44, lon: 6 },
    { id: 'poi-101', kind: 'poi', label: 'La Mie Câline', poiCategory: 'bakeries', osmId: 101, distanceKm: 11, lat: 44.1, lon: 6 },
    { id: 'poi-102', kind: 'poi', label: 'Fontaine', poiCategory: 'fountains', osmId: 102, distanceKm: 22, lat: 44.2, lon: 6 },
    { id: 'end', kind: 'end', label: 'B', distanceKm: 50, lat: 44.45, lon: 6 },
  ];
  return it;
}

const row = (it: Itinerary, id: string) => it.timeline.find((candidate) => candidate.id === id)!;

describe('nom saisi dans la colonne « Nom »', () => {
  it('est gardé tel quel et marqué comme saisi', () => {
    const it = itinerary();
    expect(renamePoiTimelineRow(it, 'poi-101', '  7-19   La Mie ')).toBe(true);
    expect(row(it, 'poi-101')).toMatchObject({ label: '7-19 La Mie', labelEdited: true });
    // Même nom : rien ne change.
    expect(renamePoiTimelineRow(it, 'poi-101', '7-19 La Mie')).toBe(false);
  });

  it('vide ou identique au nom d’origine : retour au nom du POI', () => {
    const it = itinerary();
    renamePoiTimelineRow(it, 'poi-101', 'Mie');
    expect(renamePoiTimelineRow(it, 'poi-101', '')).toBe(true);
    expect(row(it, 'poi-101').label).toBe('La Mie Câline');
    expect(row(it, 'poi-101').labelEdited).toBeUndefined();

    renamePoiTimelineRow(it, 'poi-102', 'Cimetière');
    expect(renamePoiTimelineRow(it, 'poi-102', 'Fontaine')).toBe(true);
    expect(row(it, 'poi-102')).toMatchObject({ label: 'Fontaine' });
    expect(row(it, 'poi-102').labelEdited).toBeUndefined();
    // Retaper le nom d'origine sans l'avoir changé : rien.
    expect(renamePoiTimelineRow(it, 'poi-101', 'La Mie Câline')).toBe(false);
  });

  it('seulement pour les POI', () => {
    const it = itinerary();
    expect(renamePoiTimelineRow(it, 'start', 'Chamonix')).toBe(false);
    expect(row(it, 'start').label).toBe('A');
  });
});

describe('nouvelle recherche POI le long du tracé', () => {
  const research = (it: Itinerary) => {
    const project: ItineraryProject = { ...createDefaultProject(), itineraries: [it], activeItineraryId: it.id };
    const next = applyCorridorComplete(project, it.id, [bakery, fountain], it.gpxRoute!.points);
    return next.itineraries[0]!.timeline.filter((candidate) => candidate.kind === 'poi');
  };

  it('garde le nom saisi', () => {
    const it = itinerary();
    renamePoiTimelineRow(it, 'poi-101', '7-19 La Mie');
    const rows = research(it);
    expect(rows.find((candidate) => candidate.osmId === 101)).toMatchObject({ label: '7-19 La Mie', labelEdited: true });
    expect(rows.find((candidate) => candidate.osmId === 102)?.label).toBe('Fontaine');
  });

  it('garde la pause d’un favori, même décochée (0)', () => {
    const it = itinerary();
    Object.assign(row(it, 'poi-101'), { favorite: true, favoriteSource: 'manual', durationMin: 5 });
    Object.assign(row(it, 'poi-102'), { favorite: true, favoriteSource: 'manual', durationMin: 0 });
    const rows = research(it);
    expect(rows.find((candidate) => candidate.osmId === 101)).toMatchObject({ favorite: true, durationMin: 5 });
    expect(rows.find((candidate) => candidate.osmId === 102)).toMatchObject({ favorite: true, durationMin: 0 });
  });

  it('kilomètre sur l’axe de la prédiction, pas recalculé sur la trace simplifiée', () => {
    const it = itinerary();
    // Trace affichée simplifiée : ses distances (trace d'origine) sont 2 % plus longues.
    it.gpxRoute!.points = it.gpxRoute!.points.map((point) => ({ ...point, distanceM: point.distanceM! * 1.02 }));
    const rows = research(it);
    // Boulangerie 0,1° au nord du départ, points tous les 0,009° (1 km stocké avant le × 1,02) ;
    // à vol d'oiseau sur les points, on trouvait 11,1 km.
    expect(rows.find((candidate) => candidate.osmId === 101)?.distanceKm).toBeCloseTo((0.1 / 0.009) * 1.02, 1);
  });
});
