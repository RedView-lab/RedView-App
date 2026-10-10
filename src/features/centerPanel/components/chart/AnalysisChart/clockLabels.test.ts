import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildResponsiveXAxisLabels, departureWallClock } from './format';
import { formatScheduledDayClock } from './hoverMetrics';

// Fuseau à changement d'heure, quel que soit celui de la machine (la CI est en UTC).
beforeEach(() => {
  vi.stubEnv('TZ', 'Europe/Paris');
});

describe('axe « heure » : heure murale réelle au changement d’heure (H1-1)', () => {
  // Départ samedi 24 octobre 2026 à 20:00 ; la nuit du 25, 03:00 (été) redevient 02:00 (hiver).
  const start = departureWallClock({ startDate: '2026-10-24', startTime: '20:00' })!;

  it('lit la date et l’heure du Rythme, rien sans date réelle', () => {
    expect(start.getTime()).toBe(new Date(2026, 9, 24, 20, 0).getTime());
    expect(departureWallClock({ startDate: null, startTime: '20:00' })).toBeNull();
    expect(departureWallClock({ startDate: '2026-02-31', startTime: '20:00' })).toBeNull();
  });

  it('heure de passage au survol : 10 h après le départ = 05:00, pas 06:00', () => {
    const startSecOfDay = 20 * 3600;
    expect(formatScheduledDayClock(startSecOfDay, 10 * 3600, start)).toBe('J2 - 05:00');
    // Sans date réelle : addition d'heures, comme avant.
    expect(formatScheduledDayClock(startSecOfDay, 10 * 3600)).toBe('J2 - 06:00');
  });

  it('libellés de l’axe : abscisse 30 h (départ + 10 h) = J+1 05:00', () => {
    const labels = buildResponsiveXAxisLabels([{ value: 30, ratio: 0.5 }], 'heure', 800, 'full', start);
    expect(labels[0]!.label).toBe('J+1 05:00');
    expect(buildResponsiveXAxisLabels([{ value: 30, ratio: 0.5 }], 'heure', 800, 'full')[0]!.label).toBe('J+1 06:00');
  });
});
