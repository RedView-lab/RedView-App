import { describe, expect, it } from 'vitest';

import { evaluateOpeningHoursAt, openingIntervalsOnDate } from './openingHours';

describe('openingIntervalsOnDate : passage après minuit (B2-1)', () => {
  const bar = 'Fr-Sa 18:00-02:00';

  it('donne la soirée de la veille quand le passage tombe dans sa queue', () => {
    // Dimanche 11 octobre 2026, 01:00 : la soirée du samedi court jusqu'à 02:00.
    const sunday = new Date(2026, 9, 11, 1, 0);
    expect(evaluateOpeningHoursAt(bar, sunday, 0)).toBe('open');
    expect(openingIntervalsOnDate(bar, sunday)).toEqual([{ start: 18 * 60, end: 26 * 60 }]);
    // Samedi 01:00 : c'est la soirée du vendredi qui est en cours.
    expect(openingIntervalsOnDate(bar, new Date(2026, 9, 10, 1, 0))).toEqual([{ start: 18 * 60, end: 26 * 60 }]);
  });

  it('garde les plages du jour hors de la queue de la veille', () => {
    expect(openingIntervalsOnDate(bar, new Date(2026, 9, 11, 3, 0))).toEqual([]);
    expect(openingIntervalsOnDate(bar, new Date(2026, 9, 10, 15, 0))).toEqual([{ start: 18 * 60, end: 26 * 60 }]);
    expect(openingIntervalsOnDate('Mo-Su 07:00-19:00', new Date(2026, 9, 11, 1, 0))).toEqual([{ start: 7 * 60, end: 19 * 60 }]);
  });
});
