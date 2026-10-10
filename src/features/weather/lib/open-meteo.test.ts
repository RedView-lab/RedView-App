import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WindGridDefinition } from '../types';
import { fetchWindGridData, prefetchWindGridData } from './open-meteo';

/**
 * Grille de vent (open-meteo.ts) : un chargement partagé entre l'affichage et
 * le préchargement de l'heure suivante n'est annulé que quand tous l'ont
 * abandonné — sinon passer à l'heure préchargée laissait le vent « en
 * chargement ».
 */

function grid(north: number): WindGridDefinition {
  const points = [
    { lat: north, lng: 6 },
    { lat: north, lng: 6.1 },
  ];
  return {
    bounds: { north, south: north - 0.1, east: 6.1, west: 6, spacing: 0.1 },
    rows: 1,
    cols: 2,
    spacing: 0.1,
    points,
  } as unknown as WindGridDefinition;
}

/** fetch qui répond au tour suivant (une heure demandée, chaque coordonnée) et honore l'annulation. */
function stubOpenMeteo() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const url = new URL(String(input), 'http://x');
    const lats = url.searchParams.get('latitude')!.split(',').map(Number);
    const lngs = url.searchParams.get('longitude')!.split(',').map(Number);
    const hour = url.searchParams.get('start_hour')!;
    const body = lats.map((lat, index) => ({
      latitude: lat,
      longitude: lngs[index],
      hourly: { time: [hour], wind_speed_10m: [5], wind_direction_10m: [90], wind_gusts_10m: [8] },
    }));
    const timer = setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200 })), 0);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchWindGridData : chargement partagé', () => {
  it('heure préchargée choisie puis préchargement annulé : le vent arrive quand même', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = stubOpenMeteo();
    const area = grid(45);
    // Affichage de 10:00, puis préchargement de 11:00 (et du lendemain) avec son signal.
    const previous = new AbortController();
    const prefetch = prefetchWindGridData(area, { date: '2026-10-10', time: '10:00' }, previous.signal);
    // L'utilisateur passe à 11:00 : useWind lance ce chargement et annule le précédent.
    const current = fetchWindGridData(area, { date: '2026-10-10', time: '11:00' }, new AbortController().signal);
    previous.abort();
    const points = await current;
    expect(points).toHaveLength(2);
    expect(points[0]!.speed).toBe(5);
    await prefetch;
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('chargement abandonné par son seul appelant puis redemandé : repart d’un chargement neuf', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = stubOpenMeteo();
    const area = grid(46);
    const dropped = new AbortController();
    const first = fetchWindGridData(area, { date: '2026-10-10', time: '12:00' }, dropped.signal);
    dropped.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const again = await fetchWindGridData(area, { date: '2026-10-10', time: '12:00' }, new AbortController().signal);
    expect(again).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('deux appelants : une seule requête, maintenue tant que l’un attend, progression relayée aux deux', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = stubOpenMeteo();
    const area = grid(47);
    const left = new AbortController();
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const first = fetchWindGridData(area, { date: '2026-10-10', time: '13:00' }, left.signal, firstProgress);
    const second = fetchWindGridData(area, { date: '2026-10-10', time: '13:00' }, new AbortController().signal, secondProgress);
    left.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(await second).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstProgress).toHaveBeenCalled(); // progression initiale reçue avant de partir
    expect(secondProgress.mock.calls.some(([progress]) => progress.completedBatches === 1)).toBe(true);
  });
});
