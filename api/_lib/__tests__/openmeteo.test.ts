import { describe, it, expect, vi, beforeEach } from 'vitest';
import handler from '../../openmeteo';
import type { ApiRequest, ApiResponse } from '../types';

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function call(url: string): Promise<Captured> {
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

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

const FORECAST = '/api/openmeteo/v1/forecast?latitude=45&longitude=6&hourly=temperature_2m';

describe('api/openmeteo', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('sert la réponse du VPS et la met en cache', async () => {
    vi.stubEnv('OPENMETEO_UPSTREAM', 'http://vps.test:8080/');
    const fetchMock = vi.fn(async (_target: string | URL | Request) => jsonResponse(200, { hourly: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await call(FORECAST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://vps.test:8080/v1/forecast?latitude=45&longitude=6&hourly=temperature_2m');
    expect(out.status).toBe(200);
    expect(out.headers['x-weather-source']).toBe('self-hosted-vps');
    expect(out.headers['cache-control']).toContain('max-age=300');
  });

  it('redemande à l’API publique ce que le VPS refuse', async () => {
    vi.stubEnv('OPENMETEO_UPSTREAM', 'http://vps.test:8080');
    const fetchMock = vi.fn(async (target: string | URL | Request) => (
      String(target).startsWith('http://vps.test')
        ? jsonResponse(400, { error: true, reason: 'Unknown model' })
        : jsonResponse(200, { hourly: {} })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const out = await call(FORECAST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.status).toBe(200);
    expect(out.headers['x-weather-source']).toBe('public-api');
  });

  it('transmet un 400 d’Open-Meteo (horizon dépassé) au lieu d’un 502, sans cache', async () => {
    vi.stubEnv('OPENMETEO_UPSTREAM', '');
    const reason = 'Parameter \'start_date\' is out of allowed range';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: true, reason })));
    const out = await call(FORECAST);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: true, reason });
    expect(out.headers['cache-control']).toBe('no-store');
  });

  it('transmet un 429 et son Retry-After : le backoff du client doit le voir', async () => {
    vi.stubEnv('OPENMETEO_UPSTREAM', '');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(429, { error: true, reason: 'Minutely API request limit exceeded' }, { 'retry-after': '60' })));
    const out = await call(FORECAST);
    expect(out.status).toBe(429);
    expect(out.headers['retry-after']).toBe('60');
    expect(out.headers['cache-control']).toBe('no-store');
  });

  it('répond 502 quand l’amont est en panne ou ne renvoie pas de JSON', async () => {
    vi.stubEnv('OPENMETEO_UPSTREAM', 'http://vps.test:8080');
    vi.stubGlobal('fetch', vi.fn(async (target: string | URL | Request) => {
      if (String(target).startsWith('http://vps.test')) throw new TypeError('fetch failed');
      return new Response('<html>Bad gateway</html>', { status: 503, headers: { 'content-type': 'text/html' } });
    }));
    const out = await call(FORECAST);
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: 'Upstream fetch failed' });
  });

  it('ne relaie que les chemins connus', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await call('/api/openmeteo/v1/../../admin');
    expect(out.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
