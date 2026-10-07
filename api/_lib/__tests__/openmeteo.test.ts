import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('OPENMETEO_UPSTREAM', 'http://vps.test/openmeteo/');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn(async (_target: string | URL | Request) => jsonResponse(200, { hourly: {} }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const upstreamUrl = () => new URL(String(fetchMock.mock.calls[0]?.[0]));

  it('relaie la prévision au VPS, modèle Météo-France par défaut', async () => {
    const out = await call(FORECAST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const target = upstreamUrl();
    expect(`${target.origin}${target.pathname}`).toBe('http://vps.test/openmeteo/v1/forecast');
    expect(target.searchParams.get('models')).toBe('meteofrance_seamless');
    expect(target.searchParams.get('hourly')).toBe('temperature_2m');
    expect(out.status).toBe(200);
    expect(out.headers['x-weather-source']).toBe('self-hosted-vps');
    expect(out.headers['cache-control']).toContain('max-age=300');
  });

  it('ramène les anciens noms de modèle sur ceux du VPS et refuse les autres', async () => {
    await call(`${FORECAST}&models=meteofrance_arome_france_hd`);
    expect(upstreamUrl().searchParams.get('models')).toBe('meteofrance_seamless');
    fetchMock.mockClear();
    await call(`${FORECAST}&models=meteofrance_arome_france`);
    expect(upstreamUrl().searchParams.get('models')).toBe('meteofrance_arome_france');
    fetchMock.mockClear();
    const refused = await call(`${FORECAST}&models=ecmwf_ifs025`);
    expect(refused.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('borne l’horizon à J+4 et le passé à 3 jours', async () => {
    await call(`${FORECAST}&forecast_days=16&past_days=92`);
    expect(upstreamUrl().searchParams.get('forecast_days')).toBe('4');
    expect(upstreamUrl().searchParams.get('past_days')).toBe('3');
  });

  it('refuse plus de 200 points par requête', async () => {
    const lats = Array.from({ length: 201 }, () => '45').join(',');
    const out = await call(`/api/openmeteo/v1/forecast?latitude=${lats}&longitude=${lats}&hourly=temperature_2m`);
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ne sert plus le climat et n’appelle jamais l’API publique', async () => {
    const out = await call('/api/openmeteo/v1/climate?latitude=45&longitude=6&daily=temperature_2m_mean');
    expect(out.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('répond 503 sans OPENMETEO_UPSTREAM, sans repli', async () => {
    vi.stubEnv('OPENMETEO_UPSTREAM', '');
    const out = await call(FORECAST);
    expect(out.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('transmet un 400 d’Open-Meteo au lieu d’un 502, sans cache', async () => {
    const reason = 'Parameter \'start_date\' is out of allowed range';
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: true, reason }));
    const out = await call(FORECAST);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: true, reason });
    expect(out.headers['cache-control']).toBe('no-store');
  });

  it('transmet un 429 et son Retry-After : le backoff du client doit le voir', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: true, reason: 'Too many requests' }, { 'retry-after': '60' }));
    const out = await call(FORECAST);
    expect(out.status).toBe(429);
    expect(out.headers['retry-after']).toBe('60');
    expect(out.headers['cache-control']).toBe('no-store');
  });

  it('répond 502 quand le VPS est en panne ou ne renvoie pas de JSON, sans autre essai', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await call(FORECAST)).status).toBe(502);
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 503, headers: { 'content-type': 'text/html' } }));
    const out = await call(FORECAST);
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: 'Weather service unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ne relaie que le chemin de prévision', async () => {
    const out = await call('/api/openmeteo/v1/../../admin');
    expect(out.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
