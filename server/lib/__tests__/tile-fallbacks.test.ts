import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serveTileFallback, tileFallbackFamily, tileFallbackHitsUpstream } from '../tile-fallbacks.mjs';
import { buildFixtureCog, fixtureFetch } from './operaFixture';

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
    expect(tileFallbackFamily('/contour-tiles/14/8500/5900')).toBe('contour');
    expect(tileFallbackFamily('/api/slope-tiles/1/1/1')).toBeNull();
    expect(tileFallbackFamily('/assets/slope-tiles.js')).toBeNull();
  });

  it('counts in the quota only what reaches an upstream', () => {
    expect(tileFallbackHitsUpstream('radar', new URLSearchParams())).toBe(true);
    expect(tileFallbackHitsUpstream('slope', new URLSearchParams('pf=1'))).toBe(false);
    expect(tileFallbackHitsUpstream('dem', new URLSearchParams())).toBe(false);
    expect(tileFallbackHitsUpstream('vhr', new URLSearchParams())).toBe(false);
    expect(tileFallbackHitsUpstream('contour', new URLSearchParams())).toBe(false);
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
    for (const url of ['/dem-tiles/12/1/1.png', '/vhr-tiles/19/1/1', '/contour-tiles/14/1/1', '/slope-tiles/12/1/1?pf=1']) {
      const out = await serve(url);
      expect(out.statusCode).toBe(204);
      expect(out.headers['cache-control']).toBe('no-store');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('draws an OPERA radar tile on the server, immutable once published', async () => {
    // L'image doit être dans la fenêtre que garde le bucket (24 h).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 9, 13, 22)));
    vi.stubGlobal('fetch', fixtureFetch(buildFixtureCog(), ['20261009T1320']));
    const out = await serve('/radar-tiles/6/32/22?host=opera&path=%2Fopera%2F20261009T1320&p=fill:ff0000_0_100');
    vi.useRealTimers();
    expect(out.statusCode).toBe(200);
    expect(out.headers['content-type']).toBe('image/png');
    expect(out.headers['cache-control']).toBe('public, max-age=86400, immutable');
    expect(out.headers['x-weather-source']).toBe('eumetnet-opera');
  });

  it('never reaches RainViewer any more: an old RainViewer frame gets a 204, without any fetch', async () => {
    const out = await serve('/radar-tiles/3/4/2?host=https://tilecache.rainviewer.com&path=/v2/radar/abc');
    expect(out.statusCode).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a radar frame path other than /opera/<time>, and zooms beyond the 1 km grid', async () => {
    for (const url of ['/radar-tiles/3/4/2?host=opera&path=/opera/../../etc', '/radar-tiles/8/130/90?host=opera&path=/opera/20261009T1320']) {
      expect((await serve(url)).statusCode).toBe(204);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 204 when the OPERA bucket has no such image', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    const out = await serve('/radar-tiles/3/4/2?host=opera&path=/opera/20261009T1325');
    expect(out.statusCode).toBe(204);
  });

  it('answers 204 for tile coordinates out of range', async () => {
    const out = await serve('/slope-tiles/3/99/99');
    expect(out.statusCode).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
