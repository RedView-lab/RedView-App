import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localDateTimeMs } from './forecastTime';
import { getRouteWeatherAtDistanceAndTime, resolveRouteWeatherDateRange, type RouteWeatherDataset } from './routeWeather';

// Fuseau à changement d'heure, quel que soit celui de la machine (la CI est en UTC) :
// le 25 octobre 2026 dure 25 h à Paris, le 29 mars 2026 en dure 23. Node relit
// TZ à chaque affectation ; vitest.config (unstubEnvs) le rend après chaque test.
beforeEach(() => {
  vi.stubEnv('TZ', 'Europe/Paris');
});

/**
 * Série horaire Open-Meteo d'une journée locale (`timezone=GMT` : heures UTC),
 * valeur = heure murale locale de l'instant (25 h en octobre, 23 h en mars).
 */
function dayAtStation(dateIso: string): RouteWeatherDataset['samples'][number] {
  const [year, month, day] = dateIso.split('-').map(Number) as [number, number, number];
  const midnight = new Date(year, month - 1, day).getTime();
  const instants = Array.from({ length: 25 }, (_, h) => midnight + h * 3600_000);
  const time = instants.map((ms) => new Date(ms).toISOString().slice(0, 16));
  const values = instants.map((ms) => new Date(ms).getHours());
  return {
    lat: 48.85,
    lng: 2.35,
    distanceM: 0,
    elevationM: 0,
    hourly: {
      time,
      temperature_2m: values,
      apparent_temperature: values,
      precipitation: values,
      wind_speed_10m: values,
      cloud_cover: values,
      relative_humidity_2m: values,
      sunshine_duration: values,
    },
  };
}

describe('heure de départ le jour d’un changement d’heure', () => {
  it('lit l’heure murale, pas « minuit + minutes »', () => {
    expect(localDateTimeMs('2026-10-25', '08:00')).toBe(Date.UTC(2026, 9, 25, 7, 0)); // 08:00 CET
    expect(localDateTimeMs('2026-03-29', '08:00')).toBe(Date.UTC(2026, 2, 29, 6, 0)); // 08:00 CEST
    expect(localDateTimeMs('2026-10-25', '01:30')).toBe(Date.UTC(2026, 9, 24, 23, 30)); // avant le changement
    expect(localDateTimeMs('pas une date', '08:00')).toBeNull();
  });

  it('prend la météo de l’heure de départ affichée par la frise, sans décalage d’une heure', () => {
    for (const dateIso of ['2026-10-25', '2026-03-29']) {
      const dataset: RouteWeatherDataset = {
        itineraryId: 'it',
        signature: 's',
        startDate: dateIso,
        startTime: '08:00',
        samples: [dayAtStation(dateIso)],
        fetchedAt: 0,
      };
      expect(getRouteWeatherAtDistanceAndTime(dataset, 0, 0)?.temperature, dateIso).toBe(8);
      expect(getRouteWeatherAtDistanceAndTime(dataset, 0, 3 * 3600)?.temperature, dateIso).toBe(11);
    }
  });

  it('garde dans l’horizon le dernier jour de prévision quand un changement d’heure le précède', () => {
    // Le 23 octobre, l'horizon de 4 jours va jusqu'au 26 ; 24 h × 3 tombaient le 25 à 23:00.
    expect(resolveRouteWeatherDateRange('2026-10-26', '08:00', 2, new Date(2026, 9, 23, 10, 0))).toEqual({
      startDate: '2026-10-26',
      endDate: '2026-10-26',
    });
  });
});
