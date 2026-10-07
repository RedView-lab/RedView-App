import { describe, expect, it } from 'vitest';

import type { PoiFeature } from '@/features/poi/types';
import { createDefaultItinerary } from '../../lib/project';
import { resolveFavoritePoiPauseDurationMin } from '../../sections/timeline/TimelineTimelineView/utilsParts/schedule-stops';
import type { Itinerary } from '../../types';

import {
  resolvePoiPauseDefaultMin,
  setPoiFeatureFavorite,
  setPoiFeaturePause,
  setPoiRowFavorite,
  setPoiRowPauseDuration,
} from './poiFavoritePause';

function itineraryWith(features: PoiFeature[]): Itinerary {
  const itinerary = createDefaultItinerary();
  itinerary.timeline = [
    { id: 'start', kind: 'start', label: 'A', distanceKm: 0, lat: 44, lon: 6 },
    { id: 'end', kind: 'end', label: 'B', distanceKm: 50, lat: 44.4, lon: 6 },
  ];
  itinerary.poiFeatures = features.map((feature) => ({ ...feature }));
  return itinerary;
}

const bakery: PoiFeature = { id: 101, lat: 44.1, lon: 6, category: 'bakery', name: 'Boulangerie', tags: {} };
const viewpoint: PoiFeature = { id: 102, lat: 44.2, lon: 6, category: 'viewpoint', name: null, tags: {} };
const atKm = (km: number) => () => km;

const poiRow = (itinerary: Itinerary, id: number) =>
  itinerary.timeline.find((row) => row.kind === 'poi' && row.osmId === id);
const featurePause = (itinerary: Itinerary, id: number) =>
  itinerary.poiFeatures?.find((feature) => feature.id === id)?.pauseDurationMin ?? null;

describe('POI favori ⇒ pause', () => {
  it('pose la pause de la catégorie (grille Rythme) avec le favori', () => {
    const itinerary = itineraryWith([bakery]);
    setPoiFeatureFavorite(itinerary, bakery, true, { distanceKm: atKm(12) });

    const row = poiRow(itinerary, bakery.id)!;
    expect(row.favorite).toBe(true);
    expect(row.favoriteSource).toBe('manual');
    expect(row.durationMin).toBe(15);
    expect(row.distanceKm).toBe(12);
    // La vignette de la carte lit la feature : même pause.
    expect(featurePause(itinerary, bakery.id)).toBe(15);
    expect(itinerary.poiFeatures?.find((f) => f.id === bakery.id)?.favorite).toBe(true);
  });

  it('pose 5 min pour une catégorie sans durée', () => {
    const itinerary = itineraryWith([viewpoint]);
    expect(resolvePoiPauseDefaultMin(itinerary, 'passes')).toBe(5);
    setPoiFeatureFavorite(itinerary, viewpoint, true, { distanceKm: atKm(20) });
    expect(poiRow(itinerary, viewpoint.id)!.durationMin).toBe(5);
  });

  it('pose la durée affichée par le popup quand il la donne', () => {
    const itinerary = itineraryWith([bakery]);
    setPoiFeatureFavorite(itinerary, bakery, true, { distanceKm: atKm(12), pauseMin: 20 });
    expect(poiRow(itinerary, bakery.id)!.durationMin).toBe(20);
  });

  it('garde une pause déjà posée sur le POI', () => {
    const itinerary = itineraryWith([bakery]);
    itinerary.timeline.splice(1, 0, {
      id: 'poi-timeline-101', kind: 'poi', label: 'Boulangerie', osmId: bakery.id, poiCategory: 'bakeries', distanceKm: 12, durationMin: 40,
    });
    setPoiFeatureFavorite(itinerary, bakery, true, { distanceKm: atKm(12) });
    expect(poiRow(itinerary, bakery.id)!.durationMin).toBe(40);
  });

  it('retire la pause avec le favori', () => {
    const itinerary = itineraryWith([bakery]);
    setPoiFeatureFavorite(itinerary, bakery, true, { distanceKm: atKm(12) });
    setPoiFeatureFavorite(itinerary, bakery, false, { distanceKm: atKm(12) });

    const row = poiRow(itinerary, bakery.id)!;
    expect(row.favorite).toBe(false);
    expect(row.durationMin).toBeUndefined();
    expect(featurePause(itinerary, bakery.id)).toBeNull();
  });

  it('applique la même règle depuis l’étoile de l’agenda / de la feuille de route', () => {
    const itinerary = itineraryWith([bakery]);
    itinerary.timeline.splice(1, 0, {
      id: 'poi-101', kind: 'poi', label: 'Boulangerie', osmId: bakery.id, poiCategory: 'bakeries', distanceKm: 12, favorite: false,
    });
    const row = poiRow(itinerary, bakery.id)!;

    setPoiRowFavorite(itinerary, row, true);
    expect(row.durationMin).toBe(15);
    expect(featurePause(itinerary, bakery.id)).toBe(15);

    setPoiRowFavorite(itinerary, row, false);
    expect(row.durationMin).toBeUndefined();
    expect(featurePause(itinerary, bakery.id)).toBeNull();
  });
});

describe('pause d’un POI', () => {
  it('activer la pause met le POI en favori, en un seul passage', () => {
    const itinerary = itineraryWith([bakery]);
    setPoiFeaturePause(itinerary, bakery, true, 30, { distanceKm: atKm(12) });

    const row = poiRow(itinerary, bakery.id)!;
    expect(row.favorite).toBe(true);
    expect(row.durationMin).toBe(30);
    expect(featurePause(itinerary, bakery.id)).toBe(30);
    expect(itinerary.timeline.filter((item) => item.osmId === bakery.id)).toHaveLength(1);
  });

  it('décocher la pause la retire même avec « pauses à chaque POI favori »', () => {
    const itinerary = itineraryWith([bakery]);
    itinerary.rhythm.pauseAtFavoritePois = true;
    setPoiFeatureFavorite(itinerary, bakery, true, { distanceKm: atKm(12) });
    setPoiFeaturePause(itinerary, bakery, false, 15, { distanceKm: atKm(12) });

    const row = poiRow(itinerary, bakery.id)!;
    expect(row.favorite).toBe(true);
    expect(row.durationMin).toBe(0);
    expect(featurePause(itinerary, bakery.id)).toBeNull();
    // Le planning ne pose plus de pause sur ce favori.
    expect(resolveFavoritePoiPauseDurationMin(row, itinerary.rhythm)).toBe(0);
  });

  it('une catégorie sans durée retient celle choisie', () => {
    const itinerary = itineraryWith([viewpoint]);
    setPoiFeaturePause(itinerary, viewpoint, true, 10, { distanceKm: atKm(20) });
    expect(itinerary.rhythm.poiPauseDurations.passes).toBe(10);
  });

  it('modifier la durée dans l’agenda ne change que ce POI', () => {
    const itinerary = itineraryWith([bakery]);
    setPoiFeatureFavorite(itinerary, bakery, true, { distanceKm: atKm(12) });
    const row = poiRow(itinerary, bakery.id)!;

    setPoiRowPauseDuration(itinerary, row, 25);
    expect(row.durationMin).toBe(25);
    expect(featurePause(itinerary, bakery.id)).toBe(25);
    expect(itinerary.rhythm.poiPauseDurations.bakeries).toBe(15);
    expect(resolveFavoritePoiPauseDurationMin(row, itinerary.rhythm)).toBe(25);
  });
});
