import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiNetworkError, apiFetch, withNetworkTimeout } from './apiFetch';

/** fetch qui ne répond jamais, mais respecte son signal comme le vrai. */
function hangingFetch() {
  return vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener('abort', abort);
  }));
}

describe('apiFetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rend la réponse, même en erreur HTTP (le statut reste à lire par l’appelant)', async () => {
    const response = new Response('{}', { status: 503 });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(apiFetch('/api/x', { timeoutMs: 1_000 })).resolves.toBe(response);
  });

  it('un réseau qui pend finit en ApiNetworkError(timedOut) au délai', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const pending = apiFetch('/api/x', { timeoutMs: 20_000, method: 'POST' });
    const settled = pending.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(19_999);
    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect((error as ApiNetworkError).timedOut).toBe(true);
    expect((error as Error).message).toContain('à temps');
  });

  it('une panne réseau (« Failed to fetch ») devient un message lisible', async () => {
    const cause = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw cause;
    }));
    const error = await apiFetch('/api/x', { timeoutMs: 1_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect((error as ApiNetworkError).timedOut).toBe(false);
    expect((error as Error).message).toContain('Impossible de joindre le serveur RedView');
    expect((error as Error).cause).toBe(cause);
  });

  it("l'annulation de l'appelant reste une AbortError, et le minuteur est rendu", async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    const pending = apiFetch('/api/x', { timeoutMs: 20_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('un signal déjà annulé annule tout de suite', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(apiFetch('/api/x', { timeoutMs: 20_000, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

describe('withNetworkTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('un appel qui ne répond jamais finit en ApiNetworkError(timedOut) au délai', async () => {
    const settled = withNetworkTimeout(new Promise<never>(() => {}), 20_000).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await settled;
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect((error as ApiNetworkError).timedOut).toBe(true);
  });

  it('résultat et erreur passent tels quels, et le minuteur est rendu', async () => {
    await expect(withNetworkTimeout(Promise.resolve(42), 1_000)).resolves.toBe(42);
    const refusal = Object.assign(new Error('Invalid credentials'), { code: 401 });
    await expect(withNetworkTimeout(Promise.reject(refusal), 1_000)).rejects.toBe(refusal);
    expect(vi.getTimerCount()).toBe(0);
  });
});
