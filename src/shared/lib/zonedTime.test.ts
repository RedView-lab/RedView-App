import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  shiftWallClockToTimeZone,
  timeZoneOffsetMs,
  wallClockDateToInstantMs,
  zonedDateTimeToInstantMs,
} from './zonedTime';

// Navigateur à Paris, quel que soit le fuseau de la machine (la CI est en UTC).
beforeEach(() => {
  vi.stubEnv('TZ', 'Europe/Paris');
});

describe('timeZoneOffsetMs', () => {
  it('follows daylight saving time of each zone', () => {
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 1, 12), 'Europe/Paris')).toBe(2 * 3600_000);
    expect(timeZoneOffsetMs(Date.UTC(2026, 11, 1, 12), 'Europe/Paris')).toBe(3600_000);
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 1, 12), 'Europe/Lisbon')).toBe(3600_000);
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 1, 12), 'Not/AZone')).toBeNull();
  });
});

describe('zonedDateTimeToInstantMs', () => {
  it('reads a wall clock in the given zone, not the browser one', () => {
    expect(zonedDateTimeToInstantMs('2026-07-01', '08:00', 'Europe/Lisbon')).toBe(Date.UTC(2026, 6, 1, 7));
    expect(zonedDateTimeToInstantMs('2026-07-01', '08:00', 'Europe/Istanbul')).toBe(Date.UTC(2026, 6, 1, 5));
    // Automne : 02:30 existe deux fois, la première (heure d'été) ; printemps : 02:30 n'existe pas → 03:30.
    expect(zonedDateTimeToInstantMs('2026-10-25', '02:30', 'Europe/Paris')).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(zonedDateTimeToInstantMs('2026-03-29', '02:30', 'Europe/Paris')).toBe(Date.UTC(2026, 2, 29, 1, 30));
    expect(zonedDateTimeToInstantMs('pas une date', '08:00', 'Europe/Paris')).toBeNull();
  });
});

describe('wallClockDateToInstantMs', () => {
  it('turns a departure built in the browser wall clock into the instant at the departure place (B2-3)', () => {
    // Navigateur à Paris, départ « 08:00 » d'une course au Portugal : 08:00 à Lisbonne = 07:00 UTC.
    const departure = new Date(2026, 6, 1, 8, 0);
    expect(wallClockDateToInstantMs(departure, 'Europe/Lisbon')).toBe(Date.UTC(2026, 6, 1, 7));
    expect(wallClockDateToInstantMs(departure, 'Europe/Paris')).toBe(departure.getTime());
    expect(wallClockDateToInstantMs(departure, null)).toBe(departure.getTime());
  });
});

describe('shiftWallClockToTimeZone', () => {
  it('gives the wall clock of another zone at the same instant', () => {
    // 10:00 à Paris = 11:00 à Istanbul = 09:00 à Lisbonne (été).
    const passage = new Date(2026, 6, 1, 10, 0);
    expect(shiftWallClockToTimeZone(passage, 'Europe/Paris', 'Europe/Istanbul').getHours()).toBe(11);
    expect(shiftWallClockToTimeZone(passage, 'Europe/Paris', 'Europe/Lisbon').getHours()).toBe(9);
    // Passage 00:30 à Paris : encore la veille à Lisbonne (jour de semaine des horaires).
    const night = new Date(2026, 6, 4, 0, 30); // samedi
    const lisbon = shiftWallClockToTimeZone(night, 'Europe/Paris', 'Europe/Lisbon');
    expect([lisbon.getDay(), lisbon.getHours(), lisbon.getMinutes()]).toEqual([5, 23, 30]);
    expect(shiftWallClockToTimeZone(passage, null, 'Europe/Lisbon')).toBe(passage);
  });
});
