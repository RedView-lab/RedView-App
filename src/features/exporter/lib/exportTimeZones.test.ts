import { Decoder, Stream } from '@garmin/fitsdk';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { preloadTimeZoneTable } from '@/shared/lib/timeZoneAt';

import { buildItineraryFitCourse } from './exportFit';

// Badajoz (Espagne, UTC+2 l'été) → Elvas (Portugal, UTC+1), 17 km vers l'ouest.
const START = { lat: 38.8794, lon: -6.9707 };
const FINISH_LON = -7.1628;
const POINTS = 171;
const routePoints = Array.from({ length: POINTS }, (_, index) => ({
  lat: START.lat,
  lon: START.lon + ((FINISH_LON - START.lon) * index) / (POINTS - 1),
  distanceM: index * 100,
  elevationM: 200,
}));
const TOTAL_M = (POINTS - 1) * 100;

const ONE_HOUR = {
  total_time_s: 3600,
  total_distance_m: TOTAL_M,
  points: [
    { distance_m: 0, elapsed_time_s: 0 },
    { distance_m: TOTAL_M, elapsed_time_s: 3600 },
  ],
} as unknown as PredictionResult;

function itinerary(): Itinerary {
  const bakery = { lat: START.lat + 0.0001, lon: routePoints[160]!.lon };
  return {
    id: 'frontiere',
    name: 'Frontière',
    discipline: 'road',
    // Dimanche 5 juillet 2026, 23:30 à Badajoz.
    rhythm: { startDate: '2026-07-05', startTime: '23:30' },
    gpxRoute: { name: 'Frontière', points: routePoints },
    poiFeatures: [{ id: 1, category: 'bakery', name: 'Pastelaria', tags: { opening_hours: 'Mo-Sa 07:00-20:00' }, ...bakery }],
    timeline: [
      { id: 'start', kind: 'start', label: 'Badajoz', lat: START.lat, lon: START.lon, distanceKm: 0 },
      { id: 'poi-1', kind: 'poi', label: 'Pastelaria', ...bakery, distanceKm: 16, poiCategory: 'bakeries', osmId: 1, visible: true },
      { id: 'end', kind: 'end', label: 'Elvas', lat: START.lat, lon: FINISH_LON, distanceKm: TOTAL_M / 1000 },
    ],
  } as unknown as Itinerary;
}

function decode(bytes: Uint8Array) {
  const { messages, errors } = new Decoder(Stream.fromByteArray(Array.from(bytes))).read();
  expect(errors).toEqual([]);
  return messages;
}

beforeAll(async () => {
  await preloadTimeZoneTable();
});

// Navigateur réglé sur un autre fuseau que la course (voyage, VPN).
beforeEach(() => {
  vi.stubEnv('TZ', 'America/New_York');
});

describe('export FIT : fuseau du lieu, pas du navigateur (B2-3)', () => {
  it('horodate la trace au départ à l’heure de Badajoz', () => {
    const messages = decode(buildItineraryFitCourse(itinerary(), { locale: 'fr', prediction: ONE_HOUR }));
    const first = messages.recordMesgs![0]!.timestamp as Date;
    // 23:30 à Badajoz (UTC+2) = 21:30 UTC.
    expect(first.toISOString()).toBe('2026-07-05T21:30:00.000Z');
  });

  it('lit les horaires d’un POI passée la frontière à l’heure portugaise', () => {
    const messages = decode(buildItineraryFitCourse(itinerary(), { locale: 'fr', prediction: ONE_HOUR }));
    // Passage vers 00:26 à Badajoz (lundi) = 23:26 dimanche à Elvas : fermée le dimanche.
    expect(messages.coursePointMesgs?.map((point) => point.name)).toEqual(['BOU_D11_fermé_Pastelaria']);
  });
});
