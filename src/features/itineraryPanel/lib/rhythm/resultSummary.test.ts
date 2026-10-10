import { describe, expect, it } from 'vitest';
import type { PredictionResult } from '@/features/fitPredictor';

import { createDefaultItinerary } from '../project/defaultState';
import type { Itinerary } from '../../types';
import { buildRhythmResultSummary, formatCompactDuration, formatPacePerKm, formatSpeedKmh } from './resultSummary';

/** 50 km en 2 h de déplacement (25 km/h), sans arrêt. */
function prediction(): PredictionResult {
  return {
    total_time_s: 7200,
    riding_time_s: 7200,
    stop_time_s: 0,
    total_distance_m: 50_000,
    avg_speed_kmh: 25,
    elevation_gain_m: 0,
    elevation_loss_m: 0,
    segments: [],
    points: [
      { distance_m: 0, elevation_m: 0, gradient_pct: 0, predicted_speed_kmh: 25, predicted_power_w: 150, elapsed_time_s: 0, segment_time_s: 0 },
      { distance_m: 25_000, elevation_m: 0, gradient_pct: 0, predicted_speed_kmh: 25, predicted_power_w: 150, elapsed_time_s: 3600, segment_time_s: 3600 },
      { distance_m: 50_000, elevation_m: 0, gradient_pct: 0, predicted_speed_kmh: 25, predicted_power_w: 150, elapsed_time_s: 7200, segment_time_s: 3600 },
    ],
  };
}

function itinerary(patch: Partial<Itinerary> = {}): Itinerary {
  return { ...createDefaultItinerary(), prediction: prediction(), ...patch };
}

describe('buildRhythmResultSummary', () => {
  it('rien sans prédiction', () => {
    expect(buildRhythmResultSummary(itinerary({ prediction: undefined }))).toBeNull();
  });

  it('vélo : total = déplacement, vitesse moyenne en déplacement, pas d’allure', () => {
    expect(buildRhythmResultSummary(itinerary())).toEqual({
      totalSeconds: 7200,
      movingSeconds: 7200,
      pauseSeconds: 0,
      movingKmh: 25,
      paceSecondsPerKm: null,
    });
  });

  it('pauses par intervalle : déplacement + pauses = total, vitesse sur le déplacement seul', () => {
    const base = createDefaultItinerary();
    const summary = buildRhythmResultSummary(itinerary({
      rhythm: {
        ...base.rhythm,
        pauseEveryIntervalEnabled: true,
        pauseIntervals: [{ id: 'pause-1', label: 'Pause 1', durationMin: 10, intervalMin: 60 }],
      },
    }));
    expect(summary).not.toBeNull();
    expect(summary!.pauseSeconds).toBeGreaterThan(0);
    expect(summary!.movingSeconds + summary!.pauseSeconds).toBeCloseTo(summary!.totalSeconds);
    expect(summary!.movingKmh).toBeCloseTo(25);
  });

  it('course à pied : allure en plus des km/h', () => {
    const summary = buildRhythmResultSummary(itinerary({ discipline: 'running' }));
    expect(summary?.paceSecondsPerKm).toBeCloseTo(144);
  });
});

describe('formats', () => {
  it('durée, vitesse, allure', () => {
    expect(formatCompactDuration(45 * 60)).toBe('45m');
    expect(formatCompactDuration(12 * 3600 + 5 * 60)).toBe('12h05m');
    expect(formatSpeedKmh(24.34, 'fr')).toBe('24,3\u00a0km/h');
    expect(formatSpeedKmh(24.34, 'en')).toBe('24.3\u00a0km/h');
    expect(formatPacePerKm(365)).toBe('6:05/km');
  });
});
