import { describe, expect, it } from 'vitest';

import type { PredictionResult } from '@/features/fitPredictor';
import type { TimelineItem } from '../../types';
import { buildTimelineColumnContext, fmtClock } from './TimelineColumns';
import type { StartReference } from './TimelineTimelineView/types';

/**
 * Colonne « Heure de passage » de la feuille de route : pauses planifiées
 * comprises (comme l'agenda et l'export GPS), jour du parcours précisé sur
 * un ultra de plusieurs jours.
 */

const realDate: StartReference = { reference: new Date(2026, 9, 12, 6, 0), hasRealDate: true, startMinutes: 360 };
const timeOnly: StartReference = { reference: new Date(2000, 0, 1, 6, 0), hasRealDate: false, startMinutes: 360 };

describe('fmtClock', () => {
  it('le jour du départ : l’heure seule', () => {
    expect(fmtClock(2 * 3600 + 5 * 60, realDate)).toBe('08:05');
  });

  it('les jours suivants : le jour de la semaine, ou J2 / J3 sans date de départ', () => {
    // Lundi 12 octobre 6 h + 25 h 40 = mardi 13, 7 h 40.
    expect(fmtClock(25 * 3600 + 40 * 60, realDate)).toBe('Mar 07:40');
    expect(fmtClock(25 * 3600 + 40 * 60, timeOnly)).toBe('J2 07:40');
    expect(fmtClock(49 * 3600, timeOnly)).toBe('J3 07:00');
  });

  it('sans heure de départ : le temps écoulé', () => {
    expect(fmtClock(3 * 3600 + 15 * 60, { reference: null, hasRealDate: false, startMinutes: 360 })).toBe('+3h15');
  });
});

describe('heure de passage d’une ligne', () => {
  const prediction = {
    total_time_s: 36_000,
    total_distance_m: 360_000,
    points: [
      { distance_m: 0, elapsed_time_s: 0 },
      { distance_m: 360_000, elapsed_time_s: 36_000 },
    ],
  } as unknown as PredictionResult;
  const row = (km: number): TimelineItem => ({ id: `r${km}`, kind: 'poi', label: 'x', distanceKm: km });
  const context = (km: number) => buildTimelineColumnContext({
    item: row(km),
    prevItem: null,
    nextItem: null,
    totalDistanceM: 360_000,
    prediction,
    rhythm: undefined,
    reference: realDate,
    // Nuit de 6 h au km 180 (5 h de roulage).
    stopAnchors: [{ rideElapsedSeconds: 18_000, durationMin: 360 }],
  });

  it('avant la pause : temps de roulage seul', () => {
    expect(context(90).scheduledS).toBe(9_000);
  });

  it('après la pause : la pause comptée (la feuille de route l’oubliait)', () => {
    const after = context(270);
    expect(after.elapsedS).toBe(27_000);
    expect(after.scheduledS).toBe(27_000 + 6 * 3600);
    expect(fmtClock(after.scheduledS, realDate)).toBe('19:30');
  });
});
