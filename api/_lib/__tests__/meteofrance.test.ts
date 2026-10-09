import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

type Handler = (req: ApiRequest, res: ApiResponse) => unknown;

async function loadHandler(): Promise<Handler> {
  vi.resetModules();
  return (await import('../../meteofrance')).default as Handler;
}

function call(handler: Handler, query: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) { out.status = code; return res; },
    setHeader() { return res; },
    json(data: unknown) { out.body = data; return res; },
    send(data: unknown) { out.body = data; return res; },
    end() { return res; },
  } as unknown as ApiResponse;
  const req = { method: 'GET', query, headers: {} } as unknown as ApiRequest;
  return Promise.resolve(handler(req, res)).then(() => out);
}

const CAPABILITIES = `<wcs:Capabilities>
  <wcs:CoverageId>SNOW_DEPTH__GROUND_OR_WATER_SURFACE___2026-10-07T00.00.00Z</wcs:CoverageId>
  <wcs:CoverageId>SNOW_DEPTH__GROUND_OR_WATER_SURFACE___2026-10-07T06.00.00Z</wcs:CoverageId>
</wcs:Capabilities>`;
const DESCRIBE = '<gml:beginPosition>2026-10-07T06:00:00Z</gml:beginPosition>';

describe('api/meteofrance', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('METEOFRANCE_API_KEY', 'test-key');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/GetCapabilities')) return new Response(CAPABILITIES, { status: 200 });
      if (target.includes('/DescribeCoverage')) return new Response(DESCRIBE, { status: 200 });
      // GetCoverage : le décodage GRIB n'est pas l'objet de ce test.
      return new Response('unavailable', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part));

  it('looks the latest AROME run up once for several grids', async () => {
    const handler = await loadHandler();
    await call(handler, { lonMin: '6.80', latMin: '45.80', lonMax: '6.95', latMax: '45.95' });
    await call(handler, { lonMin: '7.00', latMin: '46.00', lonMax: '7.20', latMax: '46.10' });
    expect(calls('/GetCapabilities')).toHaveLength(1);
    expect(calls('/DescribeCoverage')).toHaveLength(1);
    expect(calls('/GetCoverage')).toHaveLength(2);
    expect(String(calls('/GetCoverage')[0]?.[0])).toContain('2026-10-07T06.00.00Z');
  });

  it('does not keep a failed run lookup', async () => {
    fetchMock.mockResolvedValueOnce(new Response('quota', { status: 429 }));
    const handler = await loadHandler();
    expect((await call(handler, { lonMin: '6.8', latMin: '45.8', lonMax: '6.9', latMax: '45.9' })).status).toBe(502);
    await call(handler, { lonMin: '6.8', latMin: '45.8', lonMax: '6.9', latMax: '45.9' });
    expect(calls('/GetCapabilities')).toHaveLength(2);
  });

  it('without an API key: 503 « not configured », no upstream call, one warning only', async () => {
    vi.stubEnv('METEOFRANCE_API_KEY', '');
    const handler = await loadHandler();
    const query = { lonMin: '6.8', latMin: '45.8', lonMax: '6.9', latMax: '45.9' };
    expect((await call(handler, query)).status).toBe(503);
    expect((await call(handler, query)).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a bbox wider than 2° (the app asks for 0.8° × 0.6°)', async () => {
    const handler = await loadHandler();
    const out = await call(handler, { lonMin: '6', latMin: '45', lonMax: '8.5', latMax: '45.5' });
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const app = await call(handler, { lonMin: '6.4', latMin: '45.6', lonMax: '7.2', latMax: '46.2' });
    expect(app.status).toBe(502); // accepted, then GetCoverage fails in this test
  });

  it('shares one upstream download between simultaneous requests for the same grid', async () => {
    const handler = await loadHandler();
    const query = { lonMin: '6.80', latMin: '45.80', lonMax: '6.95', latMax: '45.95' };
    const outs = await Promise.all([call(handler, query), call(handler, query), call(handler, query)]);
    expect(outs.map((out) => out.status)).toEqual([502, 502, 502]);
    expect(calls('/GetCoverage')).toHaveLength(1);
    // a failure is not kept
    await call(handler, query);
    expect(calls('/GetCoverage')).toHaveLength(2);
  });
});
