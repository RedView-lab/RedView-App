import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchRouteWeatherDataset,
  getRouteWeatherAtDistanceAndTime,
  resolveRouteWeatherDateRange,
  sampleRouteForWeather,
  type RouteWeatherDataset,
  type RouteWeatherHourly,
} from './routeWeather';
import { preloadTimeZoneTable } from '@/shared/lib/timeZoneAt';

const NOW = new Date(2026, 9, 6, 10, 0); // 6 octobre 2026, 10:00 locale

function route(km: number, step = 500): Array<{ lat: number; lon: number; distanceM: number; elevationM: number }> {
  const n = Math.floor((km * 1000) / step) + 1;
  return Array.from({ length: n }, (_, i) => ({ lat: 45 + i * 0.004, lon: 6, distanceM: i * step, elevationM: 500 }));
}

/** Heures Open-Meteo demandées en GMT (« YYYY-MM-DDTHH:00 » UTC) à partir du 6 octobre 2026 00:00 locale. */
function hours(count: number): string[] {
  return Array.from({ length: count }, (_, h) => new Date(2026, 9, 6, h).toISOString().slice(0, 16));
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
  it('spans from the departure day to the arrival day (+1 h margin), in UTC days', () => {
    expect(resolveRouteWeatherDateRange('2026-10-06', '06:00', 30, NOW, 'UTC')).toEqual({ startDate: '2026-10-06', endDate: '2026-10-07' });
    // 06:00 + 41 h + 1 h = 8 octobre 00:00
    expect(resolveRouteWeatherDateRange('2026-10-06', '06:00', 41, NOW, 'UTC')?.endDate).toBe('2026-10-08');
    // 00:30 à Paris (UTC+2) = 5 octobre 22:30 UTC : le jour UTC précédent est demandé aussi.
    expect(resolveRouteWeatherDateRange('2026-10-06', '00:30', 2, NOW, 'Europe/Paris')).toEqual({ startDate: '2026-10-05', endDate: '2026-10-06' });
  });

  it('caps at the 4-day horizon of the self-hosted models and refuses a departure beyond it', () => {
    expect(resolveRouteWeatherDateRange('2026-10-08', '06:00', 60, NOW, 'UTC')).toEqual({ startDate: '2026-10-08', endDate: '2026-10-09' });
    expect(resolveRouteWeatherDateRange('2026-10-09', '06:00', 200, NOW, 'UTC')).toEqual({ startDate: '2026-10-09', endDate: '2026-10-09' });
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

  it('gives nothing beyond the forecast hours (E2-1), holds an edge hour within an hour of it', () => {
    // Série de 00:00 à 09:00, départ 06:00.
    expect(getRouteWeatherAtDistanceAndTime(ds, 0, 3.5 * 3600)?.temperature).toBe(16); // 09:30
    expect(getRouteWeatherAtDistanceAndTime(ds, 0, 4.5 * 3600)).toBeNull(); // 10:30
    expect(getRouteWeatherAtDistanceAndTime(ds, 0, 30 * 3600)).toBeNull();
    expect(getRouteWeatherAtDistanceAndTime(ds, 0, -6.5 * 3600)?.temperature).toBe(0); // 23:30 la veille
    expect(getRouteWeatherAtDistanceAndTime(ds, 0, -10 * 3600)).toBeNull();
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
    expect(url).toContain('timezone=GMT');
    expect(new URL(url, 'http://x').searchParams.get('latitude')?.split(',')).toHaveLength(3);
  });

  it('reads the departure at the departure place and the hours as instants, whatever the browser zone (E2-2)', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    // Heures GMT du 12 octobre ; valeur = heure UTC.
    const time = Array.from({ length: 24 }, (_, h) => `2026-10-12T${String(h).padStart(2, '0')}:00`);
    const values = time.map((_, h) => h);
    stubOpenMeteo(200, [0, 1, 2].map(() => ({
      latitude: 45,
      longitude: 6,
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
    })));
    // Départ « 08:00 » dans les Alpes (UTC+2) = 06:00 UTC, même depuis un navigateur à New York.
    const ds = await fetchRouteWeatherDataset('it-tz', route(4), '2026-10-12', '08:00');
    expect(ds?.departureTimestampMs).toBe(Date.UTC(2026, 9, 12, 6));
    expect(getRouteWeatherAtDistanceAndTime(ds!, 0, 0)?.temperature).toBe(6);
    expect(getRouteWeatherAtDistanceAndTime(ds!, 0, 90 * 60)?.temperature).toBeCloseTo(7.5, 6);
  });

  it('gives null, never invented values, when the forecast service fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    stubOpenMeteo(500, { error: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fetchRouteWeatherDataset('it-2', route(5), '2026-10-06', '08:00')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  /** Réponse valide pour `stations` stations (3 heures). */
  function forecast(stations: number, temperature: number | null = 6) {
    const time = hours(3);
    const row = (v: number | null) => [v, v, v];
    return Array.from({ length: stations }, () => ({
      latitude: 45,
      longitude: 6,
      hourly: {
        time,
        temperature_2m: row(temperature),
        apparent_temperature: row(temperature),
        precipitation: row(0),
        wind_speed_10m: row(10),
        cloud_cover: row(0),
        relative_humidity_2m: row(50),
        sunshine_duration: row(3600),
      },
    }));
  }

  /** fetch qui répond au tour suivant et honore l'annulation, comme le vrai. */
  function stubAbortableOpenMeteo() {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(forecast(3)), { status: 200 })), 0);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('a request dropped by its caller never gives null to the next one (effect re-run on each edit)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const fetchMock = stubAbortableOpenMeteo();
    await preloadTimeZoneTable();
    const points = route(4, 400);
    const previous = new AbortController();
    const dropped = fetchRouteWeatherDataset('it-3', points, '2026-10-06', '08:00', previous.signal);
    // Requête partie (après la résolution du fuseau du départ), pas encore revenue.
    for (let tick = 0; tick < 1_000 && fetchMock.mock.calls.length === 0; tick += 1) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    previous.abort(); // nettoyage de l'effet précédent
    const current = fetchRouteWeatherDataset('it-3', points, '2026-10-06', '08:00', new AbortController().signal);
    expect(await dropped).toBeNull();
    expect((await current)?.samples).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('shares one request between live callers and keeps it while one still waits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const fetchMock = stubAbortableOpenMeteo();
    const points = route(4, 250);
    const left = new AbortController();
    const first = fetchRouteWeatherDataset('it-4', points, '2026-10-06', '08:00', left.signal);
    const second = fetchRouteWeatherDataset('it-4', points, '2026-10-06', '08:00', new AbortController().signal);
    left.abort();
    expect(await first).toBeNull();
    expect((await second)?.samples).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });

  it('keeps a failure one minute instead of asking a down service again on every edit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const fetchMock = stubOpenMeteo(503, { error: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const points = route(4, 200);
    expect(await fetchRouteWeatherDataset('it-5', points, '2026-10-06', '08:00')).toBeNull();
    expect(await fetchRouteWeatherDataset('it-5', points, '2026-10-06', '08:00')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW.getTime() + 61_000);
    await fetchRouteWeatherDataset('it-5', points, '2026-10-06', '08:00');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps an empty forecast (route outside the model domain) like a real one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const fetchMock = stubOpenMeteo(200, forecast(3, null));
    const points = route(4, 100);
    expect(await fetchRouteWeatherDataset('it-6', points, '2026-10-06', '08:00')).toBeNull();
    expect(await fetchRouteWeatherDataset('it-6', points, '2026-10-06', '08:00')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
