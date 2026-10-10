import { describe, expect, it } from 'vitest';

import type { RhythmState, TimelineItem } from '../../../../types';
import { buildDayWindow, parseStartReference, relativeDayNumber, toAgendaReference, toDayKey } from './format';
import { buildScheduledTimelineState } from './schedule-state';

const HOUR = 3600;

/** Parcours de 3 jours à 18 km/h (pas de prédiction) : arrivée 60 h après le départ. */
const items: TimelineItem[] = [
  { id: 'start', kind: 'start', label: 'Départ', distanceKm: 0 },
  { id: 'poi-d1', kind: 'poi', label: 'Fontaine', distanceKm: 18 * 10 },
  { id: 'poi-d2', kind: 'poi', label: 'Boulangerie', distanceKm: 18 * 30 },
  { id: 'end', kind: 'end', label: 'Arrivée', distanceKm: 18 * 60 },
];

function rhythm(partial: Partial<RhythmState>): RhythmState {
  return partial as RhythmState;
}

describe('agenda sans date de départ : jours relatifs', () => {
  it('garde une vraie date telle quelle', () => {
    const reference = parseStartReference(rhythm({ startDate: '2026-07-01', startTime: '06:30' }));
    expect(toAgendaReference(reference)).toBe(reference);
  });

  it('place chaque jour du parcours dans sa colonne (J1, J2, J3) à son heure', () => {
    const reference = toAgendaReference(parseStartReference(rhythm({ startTime: '06:00' })));
    expect(reference.relativeDays).toBe(true);
    expect(reference.hasRealDate).toBe(true);

    const state = buildScheduledTimelineState(items, null, reference);
    const byId = new Map(state.timedItems.map((entry) => [entry.item.id, entry]));
    const day = (id: string) => relativeDayNumber(byId.get(id)!.date!);

    expect(day('start')).toBe(1);
    expect(day('poi-d1')).toBe(1); // 06:00 + 10 h = 16:00
    expect(byId.get('poi-d1')!.minuteOfDay).toBe(16 * 60);
    expect(day('poi-d2')).toBe(2); // + 30 h = J2 12:00
    expect(byId.get('poi-d2')!.minuteOfDay).toBe(12 * 60);
    expect(day('end')).toBe(3); // + 60 h = J3 18:00
    expect(byId.get('end')!.minuteOfDay).toBe(18 * 60);
    expect(new Set(state.timedItems.map((entry) => entry.dayKey)).size).toBe(3);
  });

  it('part de 8:00 sans heure de départ, comme avant', () => {
    const reference = toAgendaReference(parseStartReference(rhythm({})));
    const state = buildScheduledTimelineState(items, null, reference);
    expect(state.timedItems[0]!.minuteOfDay).toBe(8 * 60);
    expect(relativeDayNumber(state.timedItems[3]!.date!)).toBe(3); // 08:00 + 60 h = J3 20:00
  });

  it('borne la fenêtre de jours entre le départ et l’arrivée', () => {
    const reference = toAgendaReference(parseStartReference(rhythm({ startTime: '06:00' })));
    const first = reference.reference!;
    const at = (hours: number) => new Date(first.getTime() + hours * HOUR * 1000);

    const threeDays = buildDayWindow(first, { first, last: at(60) });
    expect(threeDays.map(relativeDayNumber)).toEqual([1, 2, 3]);

    const oneDay = buildDayWindow(first, { first, last: at(8) });
    expect(oneDay.map(relativeDayNumber)).toEqual([1]);

    // 10 jours : 6 colonnes, qui glissent avec le jour choisi sans dépasser J10.
    const last = at(9 * 24 + 2);
    expect(buildDayWindow(first, { first, last }).map(relativeDayNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(buildDayWindow(at(6 * 24), { first, last }).map(relativeDayNumber)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(buildDayWindow(at(9 * 24), { first, last }).map(relativeDayNumber)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('garde la fenêtre de 6 jours autour d’une vraie date', () => {
    const anchor = new Date(2026, 6, 10);
    expect(buildDayWindow(anchor).map(toDayKey)).toEqual([
      '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12',
    ]);
  });
});
