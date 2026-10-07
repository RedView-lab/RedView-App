import { describe, expect, it } from 'vitest';

import type { TimelineItem } from '../../../../types';
import { TIMELINE_VIEWPORT_TOP_INSET_PX } from '../constants';
import type { PauseAttachmentState, StartReference, TimedAutoPause, TimedTimelineItem } from '../types';
import { buildScheduledEvents } from './event-schedule';
import { positionTimelineBlocks } from './event-positioning';
import { minuteToCanvasTopPx } from './format';
import { buildScheduledStandalonePauses } from './standalone-pauses';

const START_MINUTES = 8 * 60;
const PX_PER_MINUTE = 96 / 60;
const reference: StartReference = {
  reference: new Date(2000, 0, 1, 8, 0),
  hasRealDate: false,
  startMinutes: START_MINUTES,
};
const day = new Date(2000, 0, 1);

function timed(item: TimelineItem, rideSeconds: number, stopsBeforeSeconds = 0, sortIndex = 0): TimedTimelineItem {
  const elapsedSeconds = rideSeconds + stopsBeforeSeconds;
  return {
    item,
    sortIndex,
    distanceKm: item.distanceKm ?? 0,
    rideElapsedSeconds: rideSeconds,
    elapsedSeconds,
    minuteOfDay: START_MINUTES + elapsedSeconds / 60,
    date: null,
    dayKey: null,
  };
}

const bakery: TimelineItem = { id: 'poi-1', kind: 'poi', label: 'Boulangerie', distanceKm: 30, favorite: true, durationMin: 15 };
const fountain: TimelineItem = { id: 'poi-2', kind: 'poi', label: 'Fontaine', distanceKm: 60 };

function attachment(entries: TimedTimelineItem[]): PauseAttachmentState {
  return {
    attachedByEventId: new Map(entries.map((entry) => [
      entry.item.id,
      entry.item.id === bakery.id
        ? [{ id: 'poi-pause-poi-1', durationMin: 15, visible: true, source: 'favorite-poi' as const }]
        : [],
    ])),
    unattachedPauses: [],
  };
}

describe('agenda : une seule origine verticale', () => {
  it('pose le haut d’un bloc sur la ligne de son heure', () => {
    // Arrivée à 10:00, deux heures après le départ.
    const entries = [timed(bakery, 2 * 3600, 0, 1), timed(fountain, 4 * 3600, 15 * 60, 2)];
    const events = buildScheduledEvents(entries, attachment(entries), PX_PER_MINUTE, [day], reference, START_MINUTES);
    const hourLineTopPx = minuteToCanvasTopPx(10 * 60, START_MINUTES, PX_PER_MINUTE);

    expect(hourLineTopPx).toBe(120 * PX_PER_MINUTE + TIMELINE_VIEWPORT_TOP_INSET_PX);
    expect(events[0]!.scheduledTopPx).toBeCloseTo(hourLineTopPx, 6);

    const { events: positioned } = positionTimelineBlocks(events, [], new Map(), 24 * 60 * PX_PER_MINUTE, null);
    expect(positioned[0]!.topPx).toBeCloseTo(hourLineTopPx, 6);
  });

  it('pose une pause seule sur la même origine', () => {
    const pause: TimedAutoPause = {
      id: 'interval::0',
      label: 'Pause 1',
      source: 'interval',
      attachedToItemId: null,
      sortIndex: 10_000,
      distanceKm: 40,
      durationMin: 20,
      visible: true,
      rideElapsedSeconds: 3 * 3600,
      elapsedSeconds: 3 * 3600,
      minuteOfDay: 11 * 60,
      date: null,
      dayKey: null,
    };
    const [standalone] = buildScheduledStandalonePauses([], [pause], [], PX_PER_MINUTE, START_MINUTES, [day], false);
    expect(standalone!.scheduledTopPx).toBeCloseTo(minuteToCanvasTopPx(11 * 60, START_MINUTES, PX_PER_MINUTE), 6);
  });
});

describe('agenda : jusqu’au suivant', () => {
  it('compte le roulage jusqu’au point suivant, sans la pause prise ici', () => {
    const entries = [timed(bakery, 2 * 3600, 0, 1), timed(fountain, 3 * 3600, 15 * 60, 2)];
    const [first, second] = buildScheduledEvents(entries, attachment(entries), PX_PER_MINUTE, [day], reference, START_MINUTES);
    expect(first!.toNextSeconds).toBe(3600);
    expect(second!.toNextSeconds).toBeNull();
  });

  it('prend le point suivant dans le temps, pas dans l’ordre de la feuille de route', () => {
    const passy: TimelineItem = { id: 'wp-1', kind: 'waypoint', label: 'Passy', distanceKm: 14 };
    const sallanches: TimelineItem = { id: 'wp-2', kind: 'waypoint', label: 'Sallanches', distanceKm: 28 };
    // Rangs comme après un import GPX : points de passage, puis POI.
    const entries = [
      timed(passy, 3000, 0, 1),
      timed(sallanches, 6000, 15 * 60, 2),
      timed(bakery, 3600, 0, 3),
      timed(fountain, 9000, 15 * 60, 4),
    ];
    const events = buildScheduledEvents(entries, attachment(entries), PX_PER_MINUTE, [day], reference, START_MINUTES);
    const byId = new Map(events.map((event) => [event.item.id, event]));
    expect(byId.get('wp-1')!.toNextSeconds).toBe(600);
    expect(byId.get('poi-1')!.toNextSeconds).toBe(2400);
    expect(byId.get('wp-2')!.toNextSeconds).toBe(3000);
  });
});
