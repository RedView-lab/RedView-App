import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDaySegments } from './event-schedule';
import { getMinuteOfDay } from './format';

// Fuseau à changement d'heure, quel que soit celui de la machine (la CI est en UTC).
beforeEach(() => {
  vi.stubEnv('TZ', 'Europe/Paris');
});

const PX_PER_MINUTE = 1;
const START_MINUTES = 0;

/** [haut, bas] (px) du bloc qui commence à `start` et dure `durationMin`, sur sa journée. */
function block(start: Date, durationMin: number): [number, number] {
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const [segment] = buildDaySegments(null, start, getMinuteOfDay(start), durationMin, 0, [day], true, START_MINUTES, PX_PER_MINUTE);
  return [segment!.topPx, segment!.topPx + segment!.heightPx];
}

describe('agenda : blocs au changement d’heure (B4-1)', () => {
  it('ne se chevauchent pas la nuit du 25 octobre (02:00 → 03:00 répété)', () => {
    // 01:30 (heure d'été) + 120 min de selle = 02:30 (heure d'hiver), puis le bloc suivant.
    const first = block(new Date(2026, 9, 25, 1, 30), 120);
    const nextStart = new Date(new Date(2026, 9, 25, 1, 30).getTime() + 120 * 60_000);
    expect(getMinuteOfDay(nextStart)).toBe(150); // 02:30 affiché
    const second = block(nextStart, 60);
    expect(first[1]).toBeLessThanOrEqual(second[0]);
    expect(second[0] - first[1]).toBeLessThan(1);
  });

  it('ne laissent pas de trou la nuit du 28 mars (02:00 → 03:00 sauté)', () => {
    const firstStart = new Date(2027, 2, 28, 1, 30);
    const first = block(firstStart, 60);
    const second = block(new Date(firstStart.getTime() + 60 * 60_000), 60);
    expect(second[0] - first[1]).toBeCloseTo(0, 6);
  });

  it('garde visible un bloc tenu dans l’heure répétée (02:40 été → 02:10 hiver, 4c relecture)', () => {
    // 02:40 heure d'été = 00:40 UTC ; 30 min plus tard = 01:10 UTC = 02:10 heure d'hiver.
    const start = new Date(Date.UTC(2026, 9, 25, 0, 40));
    expect([start.getHours(), start.getMinutes()]).toEqual([2, 40]);
    const [top, bottom] = block(start, 30);
    expect(bottom - top).toBeCloseTo(30, 6);
  });

  it('garde la hauteur de la durée un jour ordinaire', () => {
    expect(block(new Date(2026, 9, 20, 1, 30), 120)).toEqual([100, 220]); // marge haute du canevas : 10 px
  });
});
