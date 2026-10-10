import { describe, expect, it } from 'vitest';

import type { RhythmState } from '../../../../types';
import { parseStartReference } from './format';

const rhythm = (startDate: string | null, startTime: string | null) => ({ startDate, startTime }) as RhythmState;

describe('parseStartReference : date / heure de départ hors bornes (B4-3)', () => {
  it('refuse une date qui n’existe pas au lieu de la reporter au mois suivant', () => {
    const reference = parseStartReference(rhythm('2026-02-31', '08:00'));
    expect(reference.hasRealDate).toBe(false);
    expect(reference.startMinutes).toBe(8 * 60);
  });

  it('refuse une heure hors de 00:00–23:59 (heure par défaut, pas un report au lendemain)', () => {
    const reference = parseStartReference(rhythm('2026-10-12', '25:99'));
    expect(reference.hasRealDate).toBe(false);
    expect(reference.startMinutes).toBeLessThan(24 * 60);
    expect(parseStartReference(rhythm('2026-10-12', '08:60')).hasRealDate).toBe(false);
  });

  it('garde une date et une heure valides', () => {
    const reference = parseStartReference(rhythm('2026-10-12', '23:59'));
    expect(reference.hasRealDate).toBe(true);
    expect(reference.reference?.getTime()).toBe(new Date(2026, 9, 12, 23, 59).getTime());
  });
});
