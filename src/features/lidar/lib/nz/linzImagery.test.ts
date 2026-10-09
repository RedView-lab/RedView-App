import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchLinzImageryTile, linzBasemapsApiKey, linzImageryTileUrl, linzRetryDelayMs } from './linzImagery';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function imageResponse(status = 200, headers: Record<string, string> = { 'content-type': 'image/webp' }) {
  return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : null, { status, headers });
}

describe('linzBasemapsApiKey', () => {
  it('reads the build key and rejects empty or malformed values', () => {
    vi.stubEnv('VITE_LINZ_BASEMAPS_API_KEY', '  c01abcdefghijklmnopqrstuvwx ');
    expect(linzBasemapsApiKey()).toBe('c01abcdefghijklmnopqrstuvwx');
    vi.stubEnv('VITE_LINZ_BASEMAPS_API_KEY', '');
    expect(linzBasemapsApiKey()).toBeNull();
    vi.stubEnv('VITE_LINZ_BASEMAPS_API_KEY', 'abc&x=1');
    expect(linzBasemapsApiKey()).toBeNull();
  });
});

describe('linzImageryTileUrl', () => {
  it('builds a Web Mercator aerial tile URL on the LINZ host only', () => {
    const url = new URL(linzImageryTileUrl(19, 503_412, 336_101, 'c01key'));
    expect(url.origin).toBe('https://basemaps.linz.govt.nz');
    expect(url.pathname).toBe('/v1/tiles/aerial/WebMercatorQuad/19/503412/336101.webp');
    expect(url.searchParams.get('api')).toBe('c01key');
  });
});

describe('linzRetryDelayMs', () => {
  it('follows Retry-After, falls back to exponential backoff, and is capped', () => {
    expect(linzRetryDelayMs(0, '2')).toBe(2_000);
    expect(linzRetryDelayMs(0, null)).toBe(1_000);
    expect(linzRetryDelayMs(2, 'soon')).toBe(4_000);
    expect(linzRetryDelayMs(0, '3600')).toBe(10_000);
  });
});

describe('fetchLinzImageryTile', () => {
  it('makes no request without a key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchLinzImageryTile(19, 1, 2, null)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a rate-limited tile, then decodes it', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(imageResponse(429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(imageResponse());
    const bitmap = { close: () => {} };
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));

    const pending = fetchLinzImageryTile(19, 1, 2, 'c01key');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(bitmap);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null on a refused key, a non-image answer, a network error or an undecodable image', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode')));
    for (const answer of [
      () => Promise.resolve(imageResponse(403, { 'content-type': 'application/json' })),
      () => Promise.resolve(imageResponse(200, { 'content-type': 'application/json' })),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(imageResponse()),
    ]) {
      vi.stubGlobal('fetch', vi.fn(answer));
      await expect(fetchLinzImageryTile(19, 1, 2, 'c01key')).resolves.toBeNull();
    }
  });
});
