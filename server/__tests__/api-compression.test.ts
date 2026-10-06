import zlib from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  API_COMPRESS_SYNC_MAX_BYTES,
  compressApiBody,
  compressApiBodySync,
  pickApiEncoding,
  withVary,
} from '../api-compression.mjs';
import { acceptedEncodings } from '../static-compression.mjs';

const json = 'application/json; charset=utf-8';
const response = (overrides: Partial<Parameters<typeof pickApiEncoding>[0]> = {}) => ({
  acceptEncoding: 'gzip, deflate, br, zstd',
  contentType: json,
  contentEncoding: undefined,
  statusCode: 200,
  method: 'GET',
  size: 50_000,
  ...overrides,
});

describe('acceptedEncodings', () => {
  it('prefers brotli at equal weight and honours q-values', () => {
    expect(acceptedEncodings('gzip, br')).toEqual(['br', 'gzip']);
    expect(acceptedEncodings('br;q=0.5, gzip')).toEqual(['gzip', 'br']);
    expect(acceptedEncodings('br;q=0, gzip')).toEqual(['gzip']);
    expect(acceptedEncodings('*')).toEqual(['br', 'gzip']);
    expect(acceptedEncodings('identity')).toEqual([]);
    expect(acceptedEncodings(undefined)).toEqual([]);
  });
});

describe('pickApiEncoding', () => {
  it('compresses JSON and text bodies the client accepts', () => {
    expect(pickApiEncoding(response())).toBe('br');
    expect(pickApiEncoding(response({ acceptEncoding: 'gzip' }))).toBe('gzip');
    expect(pickApiEncoding(response({ contentType: 'text/plain; charset=utf-8' }))).toBe('br');
    expect(pickApiEncoding(response({ contentType: 'application/geo+json' }))).toBe('br');
  });

  it('leaves alone what must stay as is', () => {
    // Déjà compressé par le handler (api/brouter.ts).
    expect(pickApiEncoding(response({ contentEncoding: 'br' }))).toBeNull();
    // Binaire déjà compressé (tuiles PNG, LAZ).
    expect(pickApiEncoding(response({ contentType: 'image/png' }))).toBeNull();
    expect(pickApiEncoding(response({ contentType: 'application/octet-stream' }))).toBeNull();
    expect(pickApiEncoding(response({ contentType: 'application/jsonp' }))).toBeNull();
    expect(pickApiEncoding(response({ contentType: undefined }))).toBeNull();
    // Trop petit pour y gagner, sans corps, ou client sans compression.
    expect(pickApiEncoding(response({ size: 1023 }))).toBeNull();
    expect(pickApiEncoding(response({ statusCode: 204 }))).toBeNull();
    expect(pickApiEncoding(response({ statusCode: 304 }))).toBeNull();
    expect(pickApiEncoding(response({ method: 'HEAD' }))).toBeNull();
    expect(pickApiEncoding(response({ acceptEncoding: undefined }))).toBeNull();
  });
});

describe('compressApiBody', () => {
  const body = Buffer.from(JSON.stringify({ entries: Array.from({ length: 4000 }, (_, i) => [`Texte ${i}`, `Text ${i}`]) }));

  it('round-trips through brotli and gzip, sync and async', async () => {
    expect(body.length).toBeGreaterThan(API_COMPRESS_SYNC_MAX_BYTES);
    expect(zlib.brotliDecompressSync(compressApiBodySync(body, 'br')).equals(body)).toBe(true);
    expect(zlib.gunzipSync(compressApiBodySync(body, 'gzip')).equals(body)).toBe(true);
    const packed = await compressApiBody(body, 'br');
    expect(packed.length).toBeLessThan(body.length / 4);
    expect(zlib.brotliDecompressSync(packed).equals(body)).toBe(true);
    expect(zlib.gunzipSync(await compressApiBody(body, 'gzip')).equals(body)).toBe(true);
  });
});

describe('withVary', () => {
  it('adds the field once', () => {
    expect(withVary(undefined, 'Accept-Encoding')).toBe('Accept-Encoding');
    expect(withVary('Origin', 'Accept-Encoding')).toBe('Origin, Accept-Encoding');
    expect(withVary('origin, accept-encoding', 'Accept-Encoding')).toBe('origin, accept-encoding');
    expect(withVary(['Origin', 'Cookie'], 'Accept-Encoding')).toBe('Origin, Cookie, Accept-Encoding');
    expect(withVary('*', 'Accept-Encoding')).toBe('*');
  });
});
