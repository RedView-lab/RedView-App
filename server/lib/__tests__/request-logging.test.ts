import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { createRequestLogger, normalizeRoutePath, resolveRequestId } from '../request-logging.mjs';
import { scrubServerEvent } from '../observability.mjs';

describe('normalizeRoutePath', () => {
  it.each([
    [null, null, '/:invalid'],
    ['/health', null, '/health'],
    ['/api/health', null, '/api/health'],
    ['/api/poi', 'poi', '/api/poi'],
    ['/api/auth/verify-code', 'auth/verify-code', '/api/auth/verify-code'],
    ['/api/weather/tiles/3/4/5', 'weather', '/api/weather/*'],
    ['/api/brouter/profile', 'brouter', '/api/brouter/*'],
    ['/api/_lib/appwrite', null, '/api/:unmatched'],
    ['/slope-tiles/12/2120/1480', null, '/slope-tiles/:z/:x/:y'],
    ['/radar-tiles/5/16/11', null, '/radar-tiles/:z/:x/:y'],
    ['/assets/Dashboard-BWpNoGbz.js', null, '/assets/*'],
    ['/sw-dem/core/cache.js', null, '/sw-dem/*'],
    ['/sw-dem.js', null, '/sw-dem/*'],
    ['/project/gt20--abc123', null, '/project/:id'],
    ['/', null, '/'],
    ['/viewer', null, '/viewer'],
    ['/favicon.ico', null, '/:file'],
    ['/wp-login.php', null, '/:file'],
    ['/some/random/page', null, '/:page'],
  ])('%s (api route %s) → %s', (pathname, apiRoute, expected) => {
    expect(normalizeRoutePath(pathname, apiRoute)).toBe(expected);
  });
});

describe('resolveRequestId', () => {
  it('keeps a safe incoming X-Request-ID', () => {
    expect(resolveRequestId('edge-7f3a9c21')).toBe('edge-7f3a9c21');
    expect(resolveRequestId(['a1b2c3d4e5', 'other'])).toBe('a1b2c3d4e5');
  });

  it.each([undefined, '', 'short', 'has space inside', 'inject\nnewline-1234', 'x'.repeat(129), '<script>alert(1)</script>'])(
    'replaces %j with a fresh UUID',
    (header) => {
      expect(resolveRequestId(header)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    },
  );
});

describe('createRequestLogger', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function startServer(level = 'info') {
    const lines: Array<Record<string, unknown>> = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line));
        callback();
      },
    });
    const logRequest = createRequestLogger({ level, destination });
    server = http.createServer((req, res) => {
      logRequest(req, res);
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      (req as http.IncomingMessage & { redviewRoute?: string }).redviewRoute = normalizeRoutePath(
        pathname,
        pathname === '/api/poi' ? 'poi' : null,
      );
      res.statusCode = pathname === '/boom' ? 500 : 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server!.address() as AddressInfo;
    return { lines, base: `http://127.0.0.1:${port}` };
  }

  it('logs method, normalised route, status, duration and request id — never the query or headers', async () => {
    const { lines, base } = await startServer();
    const response = await fetch(`${base}/api/poi?secret=s3cr3t&userId=42`, {
      headers: { cookie: 'a_session=token', authorization: 'Bearer abc', 'x-request-id': 'edge-7f3a9c21' },
    });

    expect(response.headers.get('x-request-id')).toBe('edge-7f3a9c21');
    await expect.poll(() => lines.length).toBe(1);
    const [line] = lines;
    expect(line).toMatchObject({
      level: 30,
      service: 'redview-app',
      reqId: 'edge-7f3a9c21',
      req: { method: 'GET' },
      route: '/api/poi',
      res: { statusCode: 200 },
      msg: 'request completed',
    });
    expect(typeof line.responseTime).toBe('number');
    const serialized = JSON.stringify(line);
    for (const secret of ['s3cr3t', 'userId', 'a_session', 'Bearer', 'cookie', 'authorization']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('generates a request id when none is sent', async () => {
    const { lines, base } = await startServer();
    const response = await fetch(`${base}/api/poi`);
    const id = response.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(() => lines[0]?.reqId).toBe(id);
  });

  it('stays silent on a successful health check, logs server errors at error level', async () => {
    const { lines, base } = await startServer();
    await fetch(`${base}/health`);
    await fetch(`${base}/boom`);
    await expect.poll(() => lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ level: 50, route: '/:page', res: { statusCode: 500 } });
    // Pas d'erreur synthétique dont la pile ne montre que les rouages de pino-http.
    expect(lines[0]).not.toHaveProperty('err');
  });

  it('logs static assets at debug level only', async () => {
    const { lines, base } = await startServer('info');
    await fetch(`${base}/assets/main-abc.js`);
    await fetch(`${base}/api/poi`);
    await expect.poll(() => lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ route: '/api/poi' });
  });
});

describe('scrubServerEvent', () => {
  it('keeps only the method and the path of the request', () => {
    const event = scrubServerEvent({
      request: {
        method: 'POST',
        url: 'https://app.redview.tech/api/auth/verify-code?secret=abc',
        headers: { cookie: 'a_session=token' },
        cookies: { a_session: 'token' },
        query_string: 'secret=abc',
        data: '{"code":"123456"}',
      },
      user: { ip_address: '203.0.113.7' },
    });
    expect(event).toEqual({
      request: { method: 'POST', url: 'https://app.redview.tech/api/auth/verify-code' },
      user: undefined,
    });
  });
});
