import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (req: ApiRequest, res: ApiResponse) => unknown;

/** Module neuf à chaque test : le cache et le créneau amont sont des états de module. */
async function loadHandler(): Promise<Handler> {
  vi.resetModules();
  return (await import('../../geocode-iconic')).default as Handler;
}

function call(handler: Handler, query: Record<string, string>): Promise<Captured> {
  const captured: Captured = { status: 200, headers: {}, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return res; },
    setHeader(name: string, value: string) { captured.headers[name.toLowerCase()] = value; return res; },
    json(data: unknown) { captured.body = data; return res; },
    send(data: unknown) { captured.body = Buffer.isBuffer(data) ? JSON.parse(data.toString('utf-8')) : data; return res; },
    end() { return res; },
  } as unknown as ApiResponse;
  const req = { method: 'GET', query, headers: {} } as unknown as ApiRequest;
  return Promise.resolve(handler(req, res)).then(() => captured);
}

const PLACE = [{ name: 'Mont Blanc', lat: '45.83', lon: '6.86', extratags: { wikipedia: 'fr:Mont Blanc' } }];

describe('api/geocode-iconic', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn(async () => new Response(JSON.stringify(PLACE), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('relaie la langue demandée par le client (`accept-language`)', async () => {
    const handler = await loadHandler();
    const out = await call(handler, { q: 'Mont Blanc', 'accept-language': 'en', limit: '6' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual(PLACE);
    const target = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(target.searchParams.get('accept-language')).toBe('en');
    expect(target.searchParams.get('limit')).toBe('6');
  });

  it('remplace une langue invalide par le français', async () => {
    const handler = await loadHandler();
    await call(handler, { q: 'Mont Blanc', 'accept-language': 'en;q=0.9,<script>' });
    const target = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(target.searchParams.get('accept-language')).toBe('fr');
  });

  it('sert une même recherche depuis le cache, sans rappeler Nominatim', async () => {
    const handler = await loadHandler();
    const first = await call(handler, { q: 'Mont Blanc' });
    const second = await call(handler, { q: 'Mont Blanc' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.headers['x-geocoder-cache']).toBe('miss');
    expect(second.headers['x-geocoder-cache']).toBe('hit');
    expect(second.body).toEqual(PLACE);
  });

  it('espace les appels amont d’une seconde et refuse au-delà de 2 s d’attente', async () => {
    const handler = await loadHandler();
    await call(handler, { q: 'Mont Blanc' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = call(handler, { q: 'Cervin' });
    const third = call(handler, { q: 'Grandes Jorasses' });
    const fourth = await call(handler, { q: 'Eiger' });
    expect(fourth.status).toBe(503);
    expect(fourth.headers['retry-after']).toBe('2');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await second).status).toBe(200);
    expect((await third).status).toBe(200);
  });

  it('ne met pas en cache un échec amont', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Too many requests', { status: 429 }));
    const handler = await loadHandler();
    const failed = await call(handler, { q: 'Mont Blanc' });
    expect(failed.status).toBe(502);
    await vi.advanceTimersByTimeAsync(1_000);
    const retried = await call(handler, { q: 'Mont Blanc' });
    expect(retried.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuse une requête vide ou démesurée', async () => {
    const handler = await loadHandler();
    expect((await call(handler, { q: 'a' })).status).toBe(400);
    expect((await call(handler, { q: 'x'.repeat(201) })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
