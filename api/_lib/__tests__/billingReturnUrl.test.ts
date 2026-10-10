import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiRequest } from '../types';
import { billingReturnUrl } from '../billing/http';

function req(headers: Record<string, string>): ApiRequest {
  return { method: 'POST', query: {}, headers } as unknown as ApiRequest;
}

afterEach(() => vi.unstubAllEnvs());

describe('billingReturnUrl (A2-3)', () => {
  it('production : seulement l’app en https, jamais un autre sous-domaine ni http', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_BASE_URL', '');
    expect(billingReturnUrl(req({ origin: 'https://app.redview.tech' }))).toBe('https://app.redview.tech/?tab=subscription');
    expect(billingReturnUrl(req({ origin: 'https://old-landing.redview.tech' }))).toBe('https://app.redview.tech/?tab=subscription');
    expect(billingReturnUrl(req({ origin: 'http://app.redview.tech' }))).toBe('https://app.redview.tech/?tab=subscription');
    expect(billingReturnUrl(req({ origin: 'http://localhost:5173' }))).toBe('https://app.redview.tech/?tab=subscription');
    expect(billingReturnUrl(req({ 'x-forwarded-host': 'taken-over.redview.tech' }))).toBe('https://app.redview.tech/?tab=subscription');
  });

  it('développement : le serveur local', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_BASE_URL', '');
    expect(billingReturnUrl(req({ origin: 'http://localhost:5173' }))).toBe('http://localhost:5173/?tab=subscription');
    expect(billingReturnUrl(req({ host: '127.0.0.1:3000' }))).toBe('http://127.0.0.1:3000/?tab=subscription');
  });
});
