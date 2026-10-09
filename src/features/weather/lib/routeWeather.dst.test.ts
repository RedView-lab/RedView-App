import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localDateTimeMs } from './forecastTime';
import { getRouteWeatherAtDistanceAndTime, resolveRouteWeatherDateRange, type RouteWeatherDataset } from './routeWeather';

// Fuseau à changement d'heure, quel que soit celui de la machine (la CI est en UTC) :
// le 25 octobre 2026 dure 25 h à Paris, le 29 mars 2026 en dure 23. Node relit
// TZ à chaque affectation ; vitest.config (unstubEnvs) le rend après chaque test.
beforeEach(() => {
  vi.stubEnv('TZ', 'Europe/Paris');
});

/** Série horaire Open-Meteo (`timezone=auto` : heures murales) d'une journée, valeur = heure. */
function dayAtStation(dateIso: string): RouteWeatherDataset['samples'][number] {
  const time = Array.from({ length: 24 }, (_, h) => `${dateIso}T${String(h).padStart(2, '0')}:00`);
  const values = time.map((_, h) => h);
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
