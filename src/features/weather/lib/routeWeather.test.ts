import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchRouteWeatherDataset,
  getRouteWeatherAtDistanceAndTime,
  resolveRouteWeatherDateRange,
  sampleRouteForWeather,
  type RouteWeatherDataset,
  type RouteWeatherHourly,
} from './routeWeather';

const NOW = new Date(2026, 9, 6, 10, 0); // 6 octobre 2026, 10:00 locale

function route(km: number, step = 500): Array<{ lat: number; lon: number; distanceM: number; elevationM: number }> {
  const n = Math.floor((km * 1000) / step) + 1;
  return Array.from({ length: n }, (_, i) => ({ lat: 45 + i * 0.004, lon: 6, distanceM: i * step, elevationM: 500 }));
}

/** Heures murales locales « YYYY-MM-DDTHH:00 » à partir du 6 octobre 2026 00:00. */
function hours(count: number): string[] {
  return Array.from({ length: count }, (_, h) => {
    const t = new Date(2026, 9, 6, h);
    const pad = (v: number) => String(v).padStart(2, '0');
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:00`;
  });
}

function hourly(temps: number[]): RouteWeatherHourly {
  const constant = (v: number) => temps.map(() => v);
  return {
    time: hours(temps.length),
    temperature_2m: temps,
    apparent_temperature: temps.map((t) => t - 2),
    precipitation: constant(0.5),
    wind_speed_10m: constant(12),
    cloud_cover: constant(40),
    relative_humidity_2m: constant(70),
    sunshine_duration: constant(30),
  };
}

function dataset(samples: RouteWeatherDataset['samples']): RouteWeatherDataset {
  return { itineraryId: 'it', signature: 's', startDate: '2026-10-06', startTime: '06:00', samples, fetchedAt: 0 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveRouteWeatherDateRange', () => {
  it('spans from the departure day to the arrival day (+1 h margin)', () => {
    expect(resolveRouteWeatherDateRange('2026-10-06', '06:00', 30, NOW)).toEqual({ startDate: '2026-10-06', endDate: '2026-10-07' });
    // 06:00 + 41 h + 1 h = 8 octobre 00:00
    expect(resolveRouteWeatherDateRange('2026-10-06', '06:00', 41, NOW)?.endDate).toBe('2026-10-08');
  });

  it('caps at the 4-day horizon of the self-hosted models and refuses a departure beyond it', () => {
    expect(resolveRouteWeatherDateRange('2026-10-08', '06:00', 60, NOW)).toEqual({ startDate: '2026-10-08', endDate: '2026-10-09' });
    expect(resolveRouteWeatherDateRange('2026-10-09', '06:00', 200, NOW)).toEqual({ startDate: '2026-10-09', endDate: '2026-10-09' });
    expect(resolveRouteWeatherDateRange('2026-10-10', '06:00', 2, NOW)).toBeNull();
    expect(resolveRouteWeatherDateRange('pas une date', '06:00', 2, NOW)).toBeNull();
  });
});

describe('sampleRouteForWeather', () => {
  it('keeps tiny traces as they are', () => {
    const pts = [{ lat: 45, lon: 6, distanceM: 0 }, { lat: 45.01, lon: 6, distanceM: 1000, elevationM: 300 }];
    expect(sampleRouteForWeather(pts)).toEqual([
      { lat: 45, lng: 6, distanceM: 0, elevationM: 0 },
      { lat: 45.01, lng: 6, distanceM: 1000, elevationM: 300 },
    ]);
  });

  it('places 3 to 26 stations from the start to the finish', () => {
    for (const [km, count] of [[4, 3], [20, 6], [60, 12], [1200, 26]] as const) {
      const samples = sampleRouteForWeather(route(km));
      expect(samples).toHaveLength(count);
      expect(samples[0].distanceM).toBe(0);
      expect(samples[samples.length - 1].distanceM).toBe(km * 1000);
      for (let i = 1; i < samples.length; i++) expect(samples[i].distanceM).toBeGreaterThan(samples[i - 1].distanceM);
    }
  });
});

describe('getRouteWeatherAtDistanceAndTime', () => {
  // Départ 06:00 : la 7e heure (index 6) de la série.
  const ds = dataset([
    { lat: 45, lng: 6, distanceM: 0, elevationM: 0, hourly: hourly([0, 1, 2, 3, 4, 5, 10, 12, 14, 16]) },
    { lat: 45.1, lng: 6, distanceM: 10_000, elevationM: 0, hourly: hourly([0, 1, 2, 3, 4, 5, 20, 22, 24, 26]) },
  ]);

  it('interpolates between the two stations and the two hours around the point', () => {
    // 5 km (mi-chemin), départ + 30 min : station 0 → 11 °C, station 1 → 21 °C.
    const v = getRouteWeatherAtDistanceAndTime(ds, 5_000, 1800);
    expect(v?.temperature).toBeCloseTo(16, 6);
    expect(v?.feelsLike).toBeCloseTo(14, 6);
    expect(v?.windKmh).toBe(12);
  });

  it('corrects the temperature by −6.5 °C per 1 000 m above the stations', () => {
    expect(getRouteWeatherAtDistanceAndTime(ds, 0, 0, 1000)?.temperature).toBeCloseTo(10 - 6.5, 6);
  });

  it('holds the first / last forecast hour outside the series, and gives nothing for a missing hour', () => {
    expect(getRouteWeatherAtDistanceAndTime(ds, 0, -10 * 3600)?.temperature).toBe(0);
    expect(getRouteWeatherAtDistanceAndTime(ds, 0, 30 * 3600)?.temperature).toBe(16);
    const gap = dataset([{ lat: 45, lng: 6, distanceM: 0, elevationM: 0, hourly: hourly([0, 1, 2, 3, 4, 5, Number.NaN, 12]) }]);
    expect(getRouteWeatherAtDistanceAndTime(gap, 0, 600)).toBeNull();
  });
});

describe('fetchRouteWeatherDataset', () => {
  function stubOpenMeteo(status: number, body: unknown) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads every station, keeps missing values as NaN and converts the sunshine to minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const time = hours(3);
    const fetchMock = stubOpenMeteo(200, [0, 1, 2].map(() => ({
      latitude: 45,
      longitude: 6,
      hourly: {
        time,
        temperature_2m: [5, null, 7],
        apparent_temperature: [3, 4, 5],
        precipitation: [-0.1, 0.4, 0],
        wind_speed_10m: [10, 20, 30],
        cloud_cover: [120, 50, 0],
        relative_humidity_2m: [80, 80, 80],
        sunshine_duration: [1800, 3600, null],
      },
    })));
    const ds = await fetchRouteWeatherDataset('it-1', route(4), '2026-10-06', '01:00');
    expect(ds?.samples).toHaveLength(3);
    const h = ds!.samples[0].hourly;
    expect(h.temperature_2m[1]).toBeNaN();
    expect(h.precipitation[0]).toBe(0);
    expect(h.cloud_cover[0]).toBe(100);
    expect(h.sunshine_duration).toEqual([30, 60, 60]); // la 3e heure : 1 − couverture
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('timezone=auto');
    expect(new URL(url, 'http://x').searchParams.get('latitude')?.split(',')).toHaveLength(3);
  });

  it('gives null, never invented values, when the forecast service fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    stubOpenMeteo(500, { error: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fetchRouteWeatherDataset('it-2', route(5), '2026-10-06', '08:00')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
