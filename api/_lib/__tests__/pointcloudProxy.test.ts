import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

/**
 * Proxy LiDAR (api/pointcloud.ts) : seules les sources de la liste blanche
 * passent, `Range` est relayé, l'amont est interrogé sans compression (les
 * en-têtes de longueur relayés doivent décrire les octets envoyés), et les
 * erreurs ne sont jamais mises en cache.
 */

const { default: handler } = await import('../../pointcloud');

const AHN_URL = 'https://geotiles.citg.tudelft.nl/AHN5_T/31HZ2_01.LAZ';

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  ended: boolean;
}

function call(method: string, url: string, headers: Record<string, string> = {}): Promise<Captured> {
  const captured: Captured = { status: 200, headers: {}, body: undefined, ended: false };
  const res = {
    get statusCode() { return captured.status; },
    set statusCode(code: number) { captured.status = code; },
    headersSent: false,
    writableFinished: false,
    destroyed: false,
    status(code: number) { captured.status = code; return res; },
    setHeader(name: string, value: string) { captured.headers[name.toLowerCase()] = String(value); return res; },
    json(data: unknown) { captured.body = data; captured.ended = true; return res; },
    end() { captured.ended = true; return res; },
    on() { return res; },
    off() { return res; },
  } as unknown as ApiResponse;
  const req = {
    method,
    query: { url },
    headers: { ...headers },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as ApiRequest;
  return Promise.resolve(handler(req, res)).then(() => captured);
}

describe('api/pointcloud', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, {
      status: 206,
      headers: { 'content-length': '1024', 'content-range': 'bytes 0-1023/52428800', 'accept-ranges': 'bytes' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('relaie une source autorisée avec Range, sans compression amont', async () => {
    const out = await call('HEAD', AHN_URL, { range: 'bytes=0-1023' });
    expect(out.status).toBe(206);
    expect(out.headers['content-range']).toBe('bytes 0-1023/52428800');
    expect(out.headers['cache-control']).toBe('public, max-age=604800');
    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(AHN_URL);
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({ Range: 'bytes=0-1023', 'Accept-Encoding': 'identity' });
  });

  it('refuse toute autre source sans appeler l’amont', async () => {
    const out = await call('GET', 'https://evil.example/AHN5_T/31HZ2_01.LAZ');
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ne met jamais une erreur amont en cache', async () => {
    fetchMock.mockResolvedValueOnce(new Response('gone', { status: 404 }));
    const out = await call('GET', AHN_URL);
    expect(out.status).toBe(404);
    expect(out.headers['cache-control']).toBe('no-store');
  });

  it('ignore un Range composé (plusieurs plages)', async () => {
    await call('HEAD', AHN_URL, { range: 'bytes=0-10,20-30' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Range).toBeUndefined();
  });
});
