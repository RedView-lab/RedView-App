import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serveTileFallback, tileFallbackFamily, tileFallbackHitsUpstream } from '../tile-fallbacks.mjs';

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer | string | undefined;
}

function fakeResponse() {
  const captured: CapturedResponse = { statusCode: 200, headers: {}, body: undefined };
  const res = {
    set statusCode(code: number) { captured.statusCode = code; },
    get statusCode() { return captured.statusCode; },
    setHeader(name: string, value: string) { captured.headers[name.toLowerCase()] = value; },
    end(body?: Buffer | string) { captured.body = body; },
  };
  return { res: res as unknown as import('node:http').ServerResponse, captured };
}

async function serve(url: string) {
  const parsed = new URL(url, 'http://localhost');
  const family = tileFallbackFamily(parsed.pathname);
  if (!family) throw new Error(`not a tile path: ${url}`);
  const { res, captured } = fakeResponse();
  await serveTileFallback(family, parsed.pathname, parsed.searchParams, res);
  return captured;
}

describe('tileFallbackFamily', () => {
  it('recognises the five tile families and nothing else', () => {
    expect(tileFallbackFamily('/radar-tiles/3/4/2')).toBe('radar');
    expect(tileFallbackFamily('/slope-tiles/12/2100/1500')).toBe('slope');
    expect(tileFallbackFamily('/altitude-tiles/12/2100/1500')).toBe('altitude');
    expect(tileFallbackFamily('/dem-tiles/12/2100/1500.png')).toBe('dem');
    expect(tileFallbackFamily('/vhr-tiles/19/1/1')).toBe('vhr');
    expect(tileFallbackFamily('/api/slope-tiles/1/1/1')).toBeNull();
    expect(tileFallbackFamily('/assets/slope-tiles.js')).toBeNull();
  });

  it('counts in the quota only what reaches an upstream', () => {
    expect(tileFallbackHitsUpstream('radar', new URLSearchParams())).toBe(true);
    expect(tileFallbackHitsUpstream('slope', new URLSearchParams('pf=1'))).toBe(false);
    expect(tileFallbackHitsUpstream('dem', new URLSearchParams())).toBe(false);
    expect(tileFallbackHitsUpstream('vhr', new URLSearchParams())).toBe(false);
  });
});

describe('serveTileFallback', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock = vi.fn(async () => new Response(Buffer.from('png'), { status: 200, headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers 204 never cached for DEM, VHR and prefetches, without any upstream call', async () => {
    for (const url of ['/dem-tiles/12/1/1.png', '/vhr-tiles/19/1/1', '/slope-tiles/12/1/1?pf=1']) {
      const out = await serve(url);
      expect(out.statusCode).toBe(204);
      expect(out.headers['cache-control']).toBe('no-store');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('relays a radar tile from the allowed host only', async () => {
    const out = await serve('/radar-tiles/3/4/2?host=https://evil.example&path=/v2/radar/abc');
    expect(out.statusCode).toBe(200);
    expect(out.headers['content-type']).toBe('image/png');
    expect(out.headers['x-weather-source']).toBe('server-radar-proxy');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://tilecache.rainviewer.com/v2/radar/abc/512/3/4/2/2/1_1.png');
  });

  it('refuses a radar tile without a valid frame path', async () => {
    const out = await serve('/radar-tiles/3/4/2?path=../../etc');
    expect(out.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 204 when RainViewer has no image', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }));
    const out = await serve('/radar-tiles/3/4/2?path=/v2/radar/abc');
    expect(out.statusCode).toBe(204);
  });

  it('answers 204 for tile coordinates out of range', async () => {
    const out = await serve('/slope-tiles/3/99/99');
    expect(out.statusCode).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
