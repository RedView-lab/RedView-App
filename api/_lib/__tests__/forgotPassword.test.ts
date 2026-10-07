import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler from '../../auth/forgot-password';
import type { ApiRequest, ApiResponse } from '../types';

interface Captured {
  status: number;
  body: { error?: string; success?: boolean; message?: string } | undefined;
}

function call(body: Record<string, unknown>): { done: Promise<Captured>; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return res; },
    setHeader() { return res; },
    json(data: Captured['body']) { captured.body = data; return res; },
  } as unknown as ApiResponse;
  const req = { method: 'POST', query: {}, headers: {}, body } as unknown as ApiRequest;
  return { done: Promise.resolve(handler(req, res)).then(() => captured), captured };
}

function sentRecovery(fetchMock: ReturnType<typeof vi.fn>): { email: string; url: string } {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as { email: string; url: string };
}

describe('api/auth/forgot-password', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.stubEnv('APPWRITE_ENDPOINT', 'https://appwrite.test/v1');
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('demande la récupération à Appwrite et répond après un délai fixe, même si Appwrite traîne', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { done, captured } = call({ email: ' Rider@Example.test ', redirectUrl: 'https://app.redview.tech/' });
    await vi.advanceTimersByTimeAsync(299);
    expect(captured.status).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const out = await done;
    expect(out.status).toBe(200);
    expect(out.body?.success).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://appwrite.test/v1/account/recovery');
    expect(sentRecovery(fetchMock)).toEqual({ email: 'rider@example.test', url: 'https://app.redview.tech/' });
  });

  it('remplace une redirection hors liste blanche par l’app', async () => {
    const { done } = call({ email: 'rider@example.test', redirectUrl: 'https://evil.example/steal' });
    await vi.advanceTimersByTimeAsync(300);
    await done;
    expect(sentRecovery(fetchMock).url).toBe('https://app.redview.tech/');
  });

  it('refuse localhost en production', async () => {
    const { done } = call({ email: 'rider@example.test', redirectUrl: 'http://localhost:5173/' });
    await vi.advanceTimersByTimeAsync(300);
    await done;
    expect(sentRecovery(fetchMock).url).toBe('https://app.redview.tech/');
  });

  it('journalise un échec Appwrite autre que 404, sans changer la réponse', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limit', { status: 429 }));
    const { done } = call({ email: 'rider@example.test' });
    await vi.advanceTimersByTimeAsync(300);
    expect((await done).status).toBe(200);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('ne journalise pas une adresse sans compte (404)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"code":404}', { status: 404 }));
    const { done } = call({ email: 'nobody@example.test' });
    await vi.advanceTimersByTimeAsync(300);
    expect((await done).status).toBe(200);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('refuse une adresse invalide sans appeler Appwrite', async () => {
    const out = await call({ email: 'pas-une-adresse' }).done;
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
