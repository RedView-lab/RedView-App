import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

import { fixtureListing } from '../../../server/lib/__tests__/operaFixture';

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

const FRAMES = ['20261009T1310', '20261009T1315', '20261009T1320'];

describe('api/weather radar.json (EUMETNET OPERA)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 9, 13, 22)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock = vi.fn(async () => new Response(fixtureListing(FRAMES), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('liste les dernières images du bucket OPERA et garde la liste une minute pour tous les clients', async () => {
    const handler = await loadHandler();
    const first = await call(handler, '/api/weather/radar.json');
    const second = await call(handler, '/api/weather/radar.json');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      host: 'opera',
      radar: { past: FRAMES.map((frame) => expect.objectContaining({ path: `/opera/${frame}` })) },
    });
    expect(second.body).toMatchObject({ host: 'opera' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/^https:\/\/s3\.waw3-1\.cloudferro\.com\/openradar-24h\/\?list-type=2&prefix=2026%2F10%2F09%2FOPERA%2FCOMP%2F/);

    vi.advanceTimersByTime(61_000);
    await call(handler, '/api/weather/radar.json');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('répond 502 sans rien garder quand le bucket échoue ou n’a aucune image récente', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    fetchMock.mockResolvedValueOnce(new Response(fixtureListing([]), { status: 200 }));
    const handler = await loadHandler();
    expect((await call(handler, '/api/weather/radar.json')).status).toBe(502);
    expect((await call(handler, '/api/weather/radar.json')).status).toBe(502);
    expect((await call(handler, '/api/weather/radar.json')).status).toBe(200);
  });
});
