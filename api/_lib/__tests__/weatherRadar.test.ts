import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

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
    send(data: unknown) { captured.body = Buffer.isBuffer(data) ? JSON.parse(data.toString('utf-8')) : data; return res; },
    end() { return res; },
  } as unknown as ApiResponse;
  const req = { method: 'GET', url, query: {}, headers: {} } as unknown as ApiRequest;
  return Promise.resolve(handler(req, res)).then(() => captured);
}

const MAPS = { host: 'https://tilecache.rainviewer.com', radar: { past: [{ time: 1, path: '/v2/radar/abc' }] } };

describe('api/weather radar.json', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock = vi.fn(async () => new Response(JSON.stringify(MAPS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('relaie la liste RainViewer et la garde une minute pour tous les clients', async () => {
    const handler = await loadHandler();
    const first = await call(handler, '/api/weather/radar.json');
    const second = await call(handler, '/api/weather/radar.json');
    expect(first.status).toBe(200);
    expect(second.body).toEqual(MAPS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.rainviewer.com/public/weather-maps.json');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);

    vi.advanceTimersByTime(61_000);
    await call(handler, '/api/weather/radar.json');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('répond 502 sans rien garder quand RainViewer échoue', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    const handler = await loadHandler();
    expect((await call(handler, '/api/weather/radar.json')).status).toBe(502);
    expect((await call(handler, '/api/weather/radar.json')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
