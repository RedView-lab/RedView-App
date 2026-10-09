import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

/**
 * Tuiles météo du VPS (api/weather.ts) : le VPS réécrit le même fichier à
 * chaque run, donc seule une tuile versionnée par son run (`?v=`) est gardée
 * longtemps ; sans version, le cache est court.
 */

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (req: ApiRequest, res: ApiResponse) => unknown;

async function loadHandler(): Promise<Handler> {
  vi.resetModules();
  return (await import('../../weather')).default as Handler;
}

function call(handler: Handler, url: string): Promise<Captured> {
  const captured: Captured = { status: 200, headers: {}, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return res; },
    setHeader(name: string, value: string) { captured.headers[name.toLowerCase()] = value; return res; },
    json(data: unknown) { captured.body = data; return res; },
    send(data: unknown) { captured.body = data; return res; },
    end() { return res; },
  } as unknown as ApiResponse;
  const req = { method: 'GET', url, query: {}, headers: {} } as unknown as ApiRequest;
  return Promise.resolve(handler(req, res)).then(() => captured);
}

describe('api/weather tuiles', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let run = 'run-1';

  beforeEach(() => {
    vi.stubEnv('WEATHER_UPSTREAM', 'http://vps.test/weather');
    run = 'run-1';
    fetchMock = vi.fn(async () => new Response(Buffer.from(run), { status: 200, headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('une tuile versionnée par son run est immuable ; le run suivant est une autre URL', async () => {
    const handler = await loadHandler();
    const tile = '/api/weather/tiles/temp_2026-10-09T15:00:00Z.png';
    const first = await call(handler, `${tile}?v=2026-10-09T06%3A10%3A00Z`);
    expect(first.headers['cache-control']).toContain('immutable');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://vps.test/weather/tiles/temp_2026-10-09T15:00:00Z.png?v=2026-10-09T06%3A10%3A00Z');

    run = 'run-2';
    const next = await call(handler, `${tile}?v=2026-10-09T09%3A10%3A00Z`);
    expect(String(next.body)).toBe('run-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('une tuile sans version (onglet d’un ancien build) n’est gardée que 5 minutes', async () => {
    const handler = await loadHandler();
    const out = await call(handler, '/api/weather/tiles/temp_2026-10-09T15:00:00Z.png');
    expect(out.headers['cache-control']).toBe('public, max-age=300');
    expect(out.headers['cache-control']).not.toContain('immutable');
  });
});
