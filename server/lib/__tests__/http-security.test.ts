import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HttpError,
  MAX_TILE_ZOOM,
  bodyLimitFor,
  buildRadarUpstreamUrl,
  createRateLimiter,
  decodeSafePathname,
  getClientIp,
  isInsideDir,
  isPrivateOrLoopbackIp,
  listApiRoutes,
  parseTileCoords,
  rateLimitKeyForIp,
  readBodyLimited,
  resolveApiRoute,
  resolvePointcloudUpstream,
  sanitizeRangeHeader,
} from '../http-security.mjs';

const API_DIR = path.resolve(import.meta.dirname, '../../../api');
const SLOPE_TILE_RE = /^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)/;

function fakeRequest(options: {
  method?: string;
  headers?: Record<string, string | string[]>;
  remoteAddress?: string;
  chunks?: Buffer[];
}): IncomingMessage {
  const stream = Readable.from(options.chunks ?? []);
  return Object.assign(stream, {
    method: options.method ?? 'POST',
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress },
  }) as unknown as IncomingMessage;
}

describe('decodeSafePathname', () => {
  it('decodes ordinary paths', () => {
    expect(decodeSafePathname('/api/poi')).toBe('/api/poi');
    expect(decodeSafePathname('/project/Mont%20Blanc--abc')).toBe('/project/Mont Blanc--abc');
  });

  it.each([
    ['/api/..%2f_lib/appwrite', 'encoded slash traversal'],
    ['/%2e%2e/etc/passwd', 'encoded dot segments'],
    ['/assets/./x.js', 'dot segment'],
    ['/a%00b', 'NUL byte'],
    ['/a%5cb', 'backslash'],
    ['/%E0%A4%A', 'malformed escape'],
  ])('rejects %s (%s)', (raw) => {
    expect(decodeSafePathname(raw)).toBeNull();
  });
});

describe('isInsideDir', () => {
  const parent = path.resolve('/srv/dist');

  it('accepts descendants only', () => {
    expect(isInsideDir(parent, path.join(parent, 'assets', 'a.js'))).toBe(true);
    expect(isInsideDir(parent, parent)).toBe(false);
  });

  it('rejects a sibling sharing the prefix', () => {
    expect(isInsideDir(parent, path.resolve('/srv/dist_x/secret'))).toBe(false);
  });
});

describe('resolveApiRoute', () => {
  it('maps a route to its handler file', () => {
    expect(resolveApiRoute(API_DIR, '/api/poi')).toEqual({
      route: 'poi',
      file: path.join(API_DIR, 'poi.ts'),
      isAuth: false,
    });
  });

  it('flags auth routes (dedicated rate-limit bucket)', () => {
    expect(resolveApiRoute(API_DIR, '/api/auth/verify-code')?.isAuth).toBe(true);
  });

  it('collapses prefix aliases onto one handler', () => {
    expect(resolveApiRoute(API_DIR, '/api/brouter/profile/upload')?.route).toBe('brouter');
    expect(resolveApiRoute(API_DIR, '/api/weather/tiles/1/2/3')?.route).toBe('weather');
    expect(resolveApiRoute(API_DIR, '/api/openmeteo/v1/forecast')?.route).toBe('openmeteo');
  });

  it('ignores a trailing slash', () => {
    expect(resolveApiRoute(API_DIR, '/api/poi/')?.route).toBe('poi');
  });

  it.each([
    '/api/_lib/appwrite',
    '/api/_lib/config',
    '/api/.env',
    '/api/poi.ts',
    '/api/does-not-exist',
    '/api/',
    '/apipoi',
    '/static/poi',
  ])('refuses %s', (pathname) => {
    expect(resolveApiRoute(API_DIR, pathname)).toBeNull();
  });

  it('resolves bundled handlers from a known route list (no disk access)', () => {
    const bundleDir = path.resolve('/srv/dist-server/api');
    const routes = new Set(['poi', 'auth/verify-code', 'brouter']);
    expect(resolveApiRoute(bundleDir, '/api/poi', { extension: '.mjs', routes })).toEqual({
      route: 'poi',
      file: path.join(bundleDir, 'poi.mjs'),
      isAuth: false,
    });
    expect(resolveApiRoute(bundleDir, '/api/brouter/profile', { extension: '.mjs', routes })?.route).toBe('brouter');
    expect(resolveApiRoute(bundleDir, '/api/weather', { extension: '.mjs', routes })).toBeNull();
    expect(resolveApiRoute(bundleDir, '/api/_lib/appwrite', { extension: '.mjs', routes })).toBeNull();
  });
});

describe('listApiRoutes', () => {
  it('lists every handler of the source tree, never _lib nor tests', () => {
    const routes = listApiRoutes(API_DIR, '.ts');
    expect(routes.has('poi')).toBe(true);
    expect(routes.has('brouter')).toBe(true);
    expect(routes.has('auth/verify-code')).toBe(true);
    for (const route of routes) {
      expect(route).not.toMatch(/(^|\/)_|__tests__|\.test$/);
      expect(resolveApiRoute(API_DIR, `/api/${route}`)?.route).toBe(route);
    }
  });

  it('answers an empty set for a missing directory', () => {
    expect(listApiRoutes(path.join(API_DIR, 'does-not-exist'), '.mjs').size).toBe(0);
  });
});

describe('bodyLimitFor', () => {
  it('caps POI and BRouter bodies at 512 KiB, others at 1 MiB', () => {
    expect(bodyLimitFor('poi')).toBe(512 * 1024);
    expect(bodyLimitFor('brouter')).toBe(512 * 1024);
    expect(bodyLimitFor('projects/share')).toBe(1024 * 1024);
  });
});

describe('readBodyLimited', () => {
  it('returns an empty buffer for bodiless methods', async () => {
    const body = await readBodyLimited(fakeRequest({ method: 'GET', chunks: [Buffer.from('x')] }), 10);
    expect(body.length).toBe(0);
  });

  it('concatenates chunks under the limit', async () => {
    const body = await readBodyLimited(fakeRequest({ chunks: [Buffer.from('ab'), Buffer.from('cd')] }), 10);
    expect(body.toString()).toBe('abcd');
  });

  it('rejects a declared Content-Length over the limit before reading', async () => {
    const request = fakeRequest({ headers: { 'content-length': '11' }, chunks: [] });
    await expect(readBodyLimited(request, 10)).rejects.toMatchObject({ status: 413 });
  });

  it('rejects a streamed body that exceeds the limit', async () => {
    const request = fakeRequest({ chunks: [Buffer.alloc(6), Buffer.alloc(6)] });
    const error = await readBodyLimited(request, 10).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(413);
  });
});

describe('isPrivateOrLoopbackIp', () => {
  it.each(['127.0.0.1', '::1', '10.0.0.4', '192.168.1.1', '172.16.0.1', '172.31.255.255', 'fe80::1', 'fd12:3456::1'])(
    '%s is private',
    (ip) => expect(isPrivateOrLoopbackIp(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '172.32.0.1', '172.15.0.1', '2001:db8::1', ''])('%s is not private', (ip) =>
    expect(isPrivateOrLoopbackIp(ip)).toBe(false),
  );
});

describe('getClientIp', () => {
  it('trusts a public socket address and ignores forwarded headers', () => {
    const request = fakeRequest({
      remoteAddress: '203.0.113.7',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(getClientIp(request)).toBe('203.0.113.7');
  });

  it('behind the proxy, keeps only the rightmost X-Forwarded-For entry', () => {
    const request = fakeRequest({
      remoteAddress: '::ffff:10.0.1.5',
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
    });
    expect(getClientIp(request)).toBe('203.0.113.9');
  });

  it('ignores CF-Connecting-IP unless the peer is Cloudflare', () => {
    const spoofed = fakeRequest({
      remoteAddress: '10.0.1.5',
      headers: { 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '1.1.1.1' },
    });
    expect(getClientIp(spoofed)).toBe('203.0.113.9');

    const viaCloudflare = fakeRequest({
      remoteAddress: '10.0.1.5',
      headers: { 'x-forwarded-for': '162.158.1.1', 'cf-connecting-ip': '198.51.100.20' },
    });
    expect(getClientIp(viaCloudflare)).toBe('198.51.100.20');
  });

  it('falls back to the socket address when no valid forwarded entry exists', () => {
    const request = fakeRequest({ remoteAddress: '10.0.1.5', headers: { 'x-forwarded-for': 'garbage' } });
    expect(getClientIp(request)).toBe('10.0.1.5');
  });
});

describe('rateLimitKeyForIp', () => {
  it('keeps IPv4 addresses as is', () => {
    expect(rateLimitKeyForIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups an IPv6 address by its /64', () => {
    expect(rateLimitKeyForIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKeyForIp('2001:DB8:1:2::42')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKeyForIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });
});

describe('createRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows max hits per window, then resets', () => {
    vi.useFakeTimers();
    const hit = createRateLimiter({ windowMs: 1000 });
    expect(hit('a', 2)).toBe(true);
    expect(hit('a', 2)).toBe(true);
    expect(hit('a', 2)).toBe(false);
    expect(hit('b', 2)).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(hit('a', 2)).toBe(true);
  });

  it('evicts the oldest keys beyond maxKeys', () => {
    vi.useFakeTimers();
    const hit = createRateLimiter({ windowMs: 60_000, maxKeys: 2 });
    expect(hit('a', 1)).toBe(true);
    expect(hit('a', 1)).toBe(false);
    hit('b', 1);
    hit('c', 1);
    // 'a' a été évincé : son compteur repart de zéro.
    expect(hit('a', 1)).toBe(true);
  });
});

describe('parseTileCoords', () => {
  it('parses valid coordinates', () => {
    expect(parseTileCoords('/slope-tiles/12/2120/1480.png', SLOPE_TILE_RE)).toEqual({ z: 12, x: 2120, y: 1480 });
  });

  it.each([
    '/slope-tiles/12/4096/0',
    '/slope-tiles/1/0/2',
    `/slope-tiles/${MAX_TILE_ZOOM + 1}/0/0`,
    '/altitude-tiles/1/0/0',
    '/slope-tiles/a/b/c',
  ])('rejects %s', (pathname) => {
    expect(parseTileCoords(pathname, SLOPE_TILE_RE)).toBeNull();
  });
});

describe('buildRadarUpstreamUrl', () => {
  const coords = { z: 5, x: 16, y: 11 };

  it('builds a RainViewer URL on an allowed host', () => {
    const params = new URLSearchParams({ host: 'https://tilecache.rainviewer.net/', path: 'v2/radar/1700000000' });
    expect(buildRadarUpstreamUrl(params, coords)).toBe(
      'https://tilecache.rainviewer.net/v2/radar/1700000000/512/5/16/11/2/1_1.png',
    );
  });

  it('forces the default host for anything outside the allowlist (SSRF)', () => {
    const params = new URLSearchParams({ host: 'http://169.254.169.254', path: '/v2/radar/1' });
    expect(buildRadarUpstreamUrl(params, coords)).toBe('https://tilecache.rainviewer.com/v2/radar/1/512/5/16/11/2/1_1.png');
  });

  it.each(['', '../../admin', 'v2/radar/1?x=1', 'v2//radar', `v2/${'a'.repeat(200)}`])('rejects frame path %j', (framePath) => {
    expect(buildRadarUpstreamUrl(new URLSearchParams({ path: framePath }), coords)).toBeNull();
  });
});

describe('resolvePointcloudUpstream', () => {
  it('accepts AHN sub-tiles and DHMV II strips', () => {
    expect(resolvePointcloudUpstream('https://geotiles.citg.tudelft.nl/AHN5_T/31HZ2_01.LAZ')).toBe(
      'https://geotiles.citg.tudelft.nl/AHN5_T/31HZ2_01.LAZ',
    );
    expect(
      resolvePointcloudUpstream('https://remotesensing.vlaanderen.be/download/openlidar/LiDAR_DHMV_2_V2/strip-12/part_3.laz'),
    ).toBe('https://remotesensing.vlaanderen.be/download/openlidar/LiDAR_DHMV_2_V2/strip-12/part_3.laz');
  });

  it.each([
    'https://evil.example/AHN5_T/31HZ2_01.LAZ',
    'http://geotiles.citg.tudelft.nl/AHN5_T/31HZ2_01.LAZ',
    'https://geotiles.citg.tudelft.nl:8443/AHN5_T/31HZ2_01.LAZ',
    'https://user:pw@geotiles.citg.tudelft.nl/AHN5_T/31HZ2_01.LAZ',
    'https://geotiles.citg.tudelft.nl/AHN5_T/31HZ2_01.LAZ?x=1',
    'https://geotiles.citg.tudelft.nl/AHN5_T/../secret.LAZ',
    'https://geotiles.citg.tudelft.nl/other/file.LAZ',
    'not a url',
  ])('refuses %s', (url) => {
    expect(resolvePointcloudUpstream(url)).toBeNull();
  });

  it('refuses non-strings and overlong URLs', () => {
    expect(resolvePointcloudUpstream(undefined)).toBeNull();
    expect(resolvePointcloudUpstream(`https://geotiles.citg.tudelft.nl/${'a'.repeat(400)}`)).toBeNull();
  });
});

describe('sanitizeRangeHeader', () => {
  it.each(['bytes=0-99', 'bytes=100-', 'bytes=-500'])('relays %s', (range) => {
    expect(sanitizeRangeHeader(range)).toBe(range);
  });

  it.each(['bytes=-', 'bytes=0-1,5-9', 'items=0-1', 'bytes=0-1234567890123456', undefined])('drops %j', (range) => {
    expect(sanitizeRangeHeader(range)).toBeNull();
  });
});
