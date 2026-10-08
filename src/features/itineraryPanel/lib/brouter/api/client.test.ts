import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  brouterProxyAppliesBudget,
  fetchBrouterRoute,
  isBrouterBusyError,
  isBrouterQueueBusy,
  uploadCustomProfile,
} from './client';
import { buildBrouterUrl } from './url';

const ROUTE = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[6.1, 45.1], [6.2, 45.2]] },
    properties: { 'track-length': '15000', 'total-time': '3600', 'filtered ascend': '120', 'plain-ascend': '40', cost: '20000' },
  }],
};

function busy(retryAfterS = '1'): Response {
  return new Response(JSON.stringify({ error: 'BRouter busy, retry shortly' }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'retry-after': retryAfterS },
  });
}

describe('client BRouter — file du proxy pleine (503)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejoue la même requête après Retry-After, sans prévenir l’appelant d’une réponse calculée', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(busy('2'))
      .mockResolvedValueOnce(new Response(JSON.stringify(ROUTE), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const onResponseHeaders = vi.fn();
    const pending = fetchBrouterRoute({
      start: { lat: 45.1, lon: 6.1 },
      end: { lat: 45.2, lon: 6.2 },
      profile: 'custom_queue_test',
      onResponseHeaders,
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const route = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe(fetchMock.mock.calls[1]![0]);
    expect(route.distanceM).toBe(15000);
    expect(onResponseHeaders).toHaveBeenCalledTimes(1);
  });

  it('abandonne après deux nouveaux essais : « file saturée », jamais une raison d’escalader', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => busy('1'));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchBrouterRoute({ start: { lat: 45.3, lon: 6.3 }, end: { lat: 45.4, lon: 6.4 }, profile: 'custom_queue_test' });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await failure;
    expect(String(error)).toMatch(/HTTP 503/);
    expect(isBrouterBusyError(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('secours (hedge) refusé faute de place : ni nouvel essai ni attente', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => busy('1'));
    vi.stubGlobal('fetch', fetchMock);
    const error = await fetchBrouterRoute({
      start: { lat: 45.31, lon: 6.31 },
      end: { lat: 45.41, lon: 6.41 },
      profile: 'custom_queue_test',
      hedge: true,
    }).catch((caught: unknown) => caught);
    expect(isBrouterBusyError(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('hedge=1');
  });

  it('une attente dans la file du proxy signale BRouter saturé pendant une minute', async () => {
    // Bien après les 503 des tests précédents (l'état vit dans le module).
    vi.setSystemTime(new Date('2031-01-01T12:00:00Z'));
    expect(isBrouterQueueBusy()).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(ROUTE), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-upstream-wait-ms': '1200' },
    })));
    await fetchBrouterRoute({ start: { lat: 45.5, lon: 6.5 }, end: { lat: 45.6, lon: 6.6 }, profile: 'custom_queue_test' });
    expect(isBrouterQueueBusy()).toBe(true);
    vi.setSystemTime(new Date('2031-01-01T12:01:01Z'));
    expect(isBrouterQueueBusy()).toBe(false);
  });

  it('l’envoi d’un profil attend aussi son tour', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(busy('1'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ profileid: 'custom_abc' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = uploadCustomProfile('assign turnInstructionMode = 0\n');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ profileId: 'custom_abc', error: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('client BRouter — délai compté sur le calcul (budgetMs)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paramètres du proxy dans l’URL ; un proxy qui les applique le dit par X-Brouter-Budget', async () => {
    const url = buildBrouterUrl({ start: { lat: 45.1, lon: 6.1 }, end: { lat: 45.2, lon: 6.2 }, profile: 'custom_x', budgetMs: 14_000.4, hedge: true });
    expect(url).toContain('budgetMs=14000');
    expect(url).toContain('hedge=1');
    expect(buildBrouterUrl({ start: { lat: 45.1, lon: 6.1 }, end: { lat: 45.2, lon: 6.2 }, profile: 'custom_x' })).not.toMatch(/budgetMs|hedge/);
    expect(brouterProxyAppliesBudget()).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(ROUTE), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-brouter-budget': '1' },
    })));
    await fetchBrouterRoute({ start: { lat: 45.7, lon: 6.7 }, end: { lat: 45.8, lon: 6.8 }, profile: 'custom_budget_test' });
    expect(brouterProxyAppliesBudget()).toBe(true);
  });
});
