import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Délai d'une recherche (customProfileFetch.ts) : devant un proxy qui applique
 * `budgetMs`, il porte sur le calcul seul — l'attente dans la file du proxy ne
 * fait plus abandonner une recherche pour en relancer deux ou trois autres
 * (tracé grossier, ancres) derrière elle. Devant un ancien proxy, rien ne
 * change : 14 s depuis l'envoi.
 */

const ROUTE = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[6.1, 45.1], [6.15, 45.15]] },
    properties: { 'track-length': '9000', 'total-time': '1800', 'filtered ascend': '50', 'plain-ascend': '10', cost: '12000' },
  }],
};

const routeResponse = (headers: Record<string, string> = {}) => new Response(JSON.stringify(ROUTE), {
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
});

/** Réponse au bout de `delayMs` (annulable comme un vrai fetch) ; le secours est refusé faute de place. */
function slowProxy(delayMs: number, headers: Record<string, string>) {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('hedge=1')) {
      return Promise.resolve(new Response('{"error":"busy"}', { status: 503, headers: { 'content-type': 'application/json', ...headers } }));
    }
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(routeResponse(headers)), delayMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  });
}

const START = { lat: 45.1, lon: 6.1 };
const END = { lat: 45.15, lon: 6.15 };

describe('recherche avec le profil personnalisé : délai', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** Modules neufs (l'état du proxy vu vit dans le module), puis horloge simulée. */
  async function load() {
    const brouter = await import('../../lib/brouter');
    const search = await import('./customProfileFetch');
    vi.useFakeTimers();
    return { ...brouter, ...search };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('proxy qui applique budgetMs : budget envoyé, 20 s dans sa file ne font pas abandonner', async () => {
    const { fetchBrouterRoute, fetchCustomProfileRoute } = await load();
    // Une première réponse du proxy annonce qu'il applique le budget.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(routeResponse({ 'x-brouter-budget': '1' })));
    await fetchBrouterRoute({ start: { lat: 45.3, lon: 6.3 }, end: { lat: 45.31, lon: 6.31 }, profile: 'custom_p' });

    const fetchMock = slowProxy(20_000, { 'x-brouter-budget': '1' });
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchCustomProfileRoute({ start: START, end: END }, 'custom_p');
    await vi.advanceTimersByTimeAsync(20_000);
    const route = await pending;
    expect(route.distanceM).toBe(9000);
    const fine = String(fetchMock.mock.calls[0]![0]);
    expect(fine).toContain('budgetMs=14000');
    // Le secours (refusé faute de place) ne retarde ni n'annule la recherche fine.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('hedge=1'))).toBe(true);
  });

  it('ancien proxy : 14 s depuis l’envoi, file comprise', async () => {
    const { fetchCustomProfileRoute } = await load();
    const fetchMock = slowProxy(20_000, {});
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchCustomProfileRoute({ start: START, end: END }, 'custom_p').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(14_000);
    const error = await pending;
    expect(String(error)).toMatch(/timed out after 14000 ms/);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('budgetMs');
  });
});
