import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { captureServerError, flushServerObservability, initServerObservability } from '../observability.mjs';

// Substitut de GlitchTip : enregistre les enveloppes que le SDK envoie.
const envelopes: string[] = [];
let receiver: http.Server;
let dsn = '';

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      envelopes.push((req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', () => resolve()));
  dsn = `http://publickey@127.0.0.1:${(receiver.address() as AddressInfo).port}/1`;
});

afterAll(async () => {
  await flushServerObservability(1000);
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

describe('server error reporting', () => {
  it('stays off without SENTRY_DSN_SERVER', () => {
    expect(initServerObservability({})).toBe(false);
    captureServerError(new Error('ignored'));
  });

  it('sends the error with route, request id and release, without personal data', async () => {
    expect(initServerObservability({ SENTRY_DSN_SERVER: dsn, SOURCE_COMMIT: 'abcdef1234567890', NODE_ENV: 'test' })).toBe(true);

    captureServerError(new Error('handler exploded'), { route: '/api/poi', requestId: 'edge-7f3a9c21', method: 'POST' });
    await flushServerObservability(5000);

    const envelope = envelopes.find((entry) => entry.includes('handler exploded'));
    expect(envelope).toBeDefined();
    const event = JSON.parse(envelope!.split('\n').find((line) => line.includes('"exception"'))!);
    expect(event.tags).toMatchObject({ route: '/api/poi', request_id: 'edge-7f3a9c21', method: 'POST' });
    expect(event.release).toBe('abcdef123456');
    expect(event.environment).toBe('test');
    expect(event.exception.values[0]).toMatchObject({ type: 'Error', value: 'handler exploded' });
    expect(envelope).not.toContain('ip_address');
  });
});
