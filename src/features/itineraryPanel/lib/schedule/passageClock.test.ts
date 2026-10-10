import { describe, expect, it } from 'vitest';

import type { PredictionResult } from '@/features/fitPredictor';
import { createDefaultItinerary } from '../project';
import type { Itinerary } from '../../types';

import { buildRoutePassageClock } from './passageClock';

const TOTAL_M = 100_000;

function itinerary(): Itinerary {
  const it = createDefaultItinerary();
  it.discipline = 'bike';
  it.rhythm = { ...it.rhythm, startDate: '2026-10-12', startTime: '06:00' };
  it.gpxRoute = {
    name: null,
    source: 'gpx',
    points: Array.from({ length: 101 }, (_, index) => ({ lat: 44 + index / 111, lon: 6, distanceM: index * 1_000 })),
  };
  it.timeline = [
    { id: 'start', kind: 'start', label: 'A', distanceKm: 0, lat: 44, lon: 6 },
    // Nuit de 6 h à mi-parcours.
    { id: 'night', kind: 'pause', label: 'Nuit', distanceKm: 50, durationMin: 360 },
    { id: 'end', kind: 'end', label: 'B', distanceKm: 100, lat: 44 + 100 / 111, lon: 6 },
  ];
  return it;
}

describe('horloge de passage sans prédiction (B4-2)', () => {
  it('compte les pauses de la feuille de route à la vitesse de repli', () => {
    const clock = buildRoutePassageClock(itinerary(), null);
    expect(clock.usedPrediction).toBe(false);
    const before = clock.scheduledSecondsAt(40_000, TOTAL_M);
    const after = clock.scheduledSecondsAt(80_000, TOTAL_M);
    // 18 km/h : 40 km = 8 000 s ; 80 km = 16 000 s + la nuit de 6 h.
    expect(before).toBeCloseTo(8_000, 0);
    expect(after).toBeCloseTo(16_000 + 6 * 3600, 0);
  });

  it('garde les pauses avec une prédiction, comme avant', () => {
    const prediction = {
      total_time_s: 20_000,
      total_distance_m: TOTAL_M,
      points: [{ distance_m: 0, elapsed_time_s: 0 }, { distance_m: TOTAL_M, elapsed_time_s: 20_000 }],
    } as unknown as PredictionResult;
    const clock = buildRoutePassageClock(itinerary(), prediction);
    expect(clock.scheduledSecondsAt(80_000, TOTAL_M)).toBeCloseTo(16_000 + 6 * 3600, 0);
  });
});
