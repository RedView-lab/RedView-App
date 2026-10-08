import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiRequest, ApiResponse } from '../types';

/**
 * File d'attente du proxy /api/brouter (upstreamGate.ts) : BRouter tue son
 * calcul le plus ancien au-delà de ses fils ; le proxy ne lui en envoie
 * jamais plus que BROUTER_MAX_CONCURRENCY.
 */

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  done: Promise<void>;
  close(): void;
}

type Handler = (req: ApiRequest, res: ApiResponse) => Promise<unknown>;

function call(handler: Handler, query: Record<string, string>, method = 'GET', body?: string): Captured {
  const emitter = new EventEmitter();
  let finish!: () => void;
  const captured: Captured = {
    status: 200,
    headers: {},
    body: undefined,
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    close: () => emitter.emit('close'),
  };
  const res = Object.assign(emitter, {
    writableFinished: false,
    status(code: number) {
      captured.status = code;
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return res;
    },
    json(data: unknown) {
      captured.body = data;
      res.writableFinished = true;
      return res;
    },
    send(data: unknown) {
      captured.body = data;
      res.writableFinished = true;
      return res;
    },
    end() {
      res.writableFinished = true;
      return res;
    },
  });
  const req = { method, url: '/api/brouter', query, headers: {}, body } as unknown as ApiRequest;
  void Promise.resolve(handler(req, res as unknown as ApiResponse)).finally(finish);
  return captured;
}

/** Faux BRouter : chaque requête attend qu'on la termine à la main. */
function fakeBrouter() {
  const inFlight: Array<{ url: string; finish(body?: string, contentType?: string): void }> = [];
  let maxInFlight = 0;
  const fetchMock = vi.fn((target: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const url = String(target);
    const entry = {
      url,
      finish: (body?: string, contentType = 'application/json') => {
        inFlight.splice(inFlight.indexOf(entry), 1);
        resolve(new Response(body ?? (url.includes('/profile/')
          ? JSON.stringify({ profileid: 'custom_x' })
          : JSON.stringify({ type: 'FeatureCollection', features: [] })), { status: 200, headers: { 'content-type': contentType } }));
      },
    };
    init?.signal?.addEventListener('abort', () => {
      const index = inFlight.indexOf(entry);
      if (index >= 0) inFlight.splice(index, 1);
      reject(new DOMException('aborted', 'AbortError'));
    });
    inFlight.push(entry);
    maxInFlight = Math.max(maxInFlight, inFlight.length);
  }));
  return { fetchMock, inFlight, maxInFlight: () => maxInFlight };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const route = (index: number) => ({ lonlats: `6.${index},45.1|6.${index},45.2`, profile: 'custom_test' });

describe('api/brouter — file d’attente vers BRouter', () => {
  let brouter: ReturnType<typeof fakeBrouter>;
  let handler: Handler;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('BROUTER_UPSTREAM', 'http://brouter.test');
    vi.stubEnv('BROUTER_MAX_CONCURRENCY', '4');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    brouter = fakeBrouter();
    vi.stubGlobal('fetch', brouter.fetchMock);
    handler = (await import('../../brouter')).default as Handler;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('n’envoie jamais plus de 4 calculs à la fois, les suivants passent dans l’ordre', async () => {
    const calls = Array.from({ length: 6 }, (_, index) => call(handler, route(index)));
    await flush();
    expect(brouter.inFlight).toHaveLength(4);
    brouter.inFlight[0]!.finish();
    await calls[0]!.done;
    await flush();
    expect(brouter.inFlight).toHaveLength(4);
    expect(brouter.inFlight.some((entry) => entry.url.includes('6.4%2C45.1'))).toBe(true);
    while (brouter.inFlight.length) {
      brouter.inFlight[0]!.finish();
      await flush();
      await flush();
    }
    await Promise.all(calls.map((captured) => captured.done));
    expect(brouter.maxInFlight()).toBe(4);
    expect(calls.every((captured) => captured.status === 200)).toBe(true);
    expect(calls[5]!.headers['x-upstream-wait-ms']).toBeDefined();
  });

  it('une requête dont le client part pendant l’attente n’est jamais envoyée', async () => {
    const running = Array.from({ length: 4 }, (_, index) => call(handler, route(index)));
    const abandoned = call(handler, route(9));
    await flush();
    abandoned.close();
    await abandoned.done;
    for (const entry of [...brouter.inFlight]) entry.finish();
    await Promise.all(running.map((captured) => captured.done));
    await flush();
    expect(brouter.fetchMock).toHaveBeenCalledTimes(4);
    expect(brouter.fetchMock.mock.calls.some(([url]) => String(url).includes('6.9%2C45.1'))).toBe(false);
  });

  it('l’envoi d’un profil prend aussi une place (il occupe un fil de BRouter)', async () => {
    const routes = Array.from({ length: 4 }, (_, index) => call(handler, route(index)));
    const upload = call(handler, { upload: '1' }, 'POST', 'assign turnInstructionMode = 0\n');
    await flush();
    expect(brouter.inFlight).toHaveLength(4);
    expect(brouter.inFlight.some((entry) => entry.url.includes('/profile/'))).toBe(false);
    brouter.inFlight[0]!.finish();
    await flush();
    await flush();
    expect(brouter.inFlight.some((entry) => entry.url.includes('/profile/'))).toBe(true);
    for (const entry of [...brouter.inFlight]) entry.finish();
    await Promise.all([...routes, upload].map((captured) => captured.done));
    expect(upload.status).toBe(200);
  });

  it('des envois simultanés du même profil partagent un seul envoi vers BRouter', async () => {
    const profile = 'assign turnInstructionMode = 1\n';
    const uploads = Array.from({ length: 3 }, () => call(handler, { upload: '1' }, 'POST', profile));
    await flush();
    expect(brouter.inFlight.filter((entry) => entry.url.includes('/profile/'))).toHaveLength(1);
    brouter.inFlight[0]!.finish();
    await Promise.all(uploads.map((captured) => captured.done));
    expect(brouter.fetchMock).toHaveBeenCalledTimes(1);
    expect(uploads.every((captured) => captured.status === 200)).toBe(true);
  });

  it('un profil déjà accepté n’est jamais renvoyé à BRouter (≥ 1 s d’un de ses fils)', async () => {
    const profile = 'assign turnInstructionMode = 2\n';
    const first = call(handler, { upload: '1' }, 'POST', profile);
    await flush();
    const id = new URL(brouter.inFlight[0]!.url).pathname.split('/').pop()!;
    brouter.inFlight[0]!.finish(JSON.stringify({ profileid: id }));
    await first.done;
    const again = call(handler, { upload: '1' }, 'POST', profile);
    await again.done;
    expect(brouter.fetchMock).toHaveBeenCalledTimes(1);
    expect(again.headers['x-profile-cache']).toBe('HIT');
    expect(again.body).toEqual({ profileid: id });
  });

  it('un profil refusé à la compilation est renvoyé à chaque fois', async () => {
    const profile = 'assign broken = \n';
    for (let round = 0; round < 2; round += 1) {
      const upload = call(handler, { upload: '1' }, 'POST', profile);
      await flush();
      brouter.inFlight[0]!.finish(JSON.stringify({ profileid: 'x', error: 'Profile error: syntax' }));
      await upload.done;
    }
    expect(brouter.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un profil accepté dont BRouter a perdu le fichier est renvoyé, puis le tracé rejoué', async () => {
    const profile = 'assign turnInstructionMode = 3\n';
    const upload = call(handler, { upload: '1' }, 'POST', profile);
    await flush();
    const id = new URL(brouter.inFlight[0]!.url).pathname.split('/').pop()!;
    brouter.inFlight[0]!.finish(JSON.stringify({ profileid: id }));
    await upload.done;

    const routed = call(handler, { lonlats: '6.1,45.1|6.1,45.2', profile: id });
    await flush();
    const hash = id.slice('custom_'.length);
    brouter.inFlight[0]!.finish(`error: profile ${hash}.brf does not exist`, 'text/plain');
    await flush();
    await flush();
    expect(brouter.inFlight[0]!.url).toContain(`/profile/${id}`);
    brouter.inFlight[0]!.finish(JSON.stringify({ profileid: id }));
    await flush();
    await flush();
    expect(brouter.inFlight[0]!.url).toContain('lonlats=');
    brouter.inFlight[0]!.finish();
    await routed.done;
    expect(routed.status).toBe(200);
    expect(brouter.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('budgetMs : délai de calcul compté après la file ; à l’échéance, 504 « compute » et place rendue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const busy = Array.from({ length: 4 }, (_, index) => call(handler, route(index)));
      const budgeted = call(handler, { ...route(5), budgetMs: '3000' });
      await vi.advanceTimersByTimeAsync(5_000);
      // 5 s dans la file : son délai de calcul n'a pas commencé.
      expect(budgeted.body).toBeUndefined();
      brouter.inFlight[0]!.finish();
      await vi.advanceTimersByTimeAsync(2_900);
      expect(budgeted.body).toBeUndefined();
      expect(brouter.inFlight.some((entry) => entry.url.includes('6.5%2C45.1'))).toBe(true);
      const after = call(handler, route(6));
      await vi.advanceTimersByTimeAsync(200);
      await budgeted.done;
      expect(budgeted.status).toBe(504);
      expect(budgeted.headers['x-brouter-timeout']).toBe('compute');
      // Requête interrompue, place rendue : la suivante part.
      expect(brouter.inFlight.some((entry) => entry.url.includes('6.5%2C45.1'))).toBe(false);
      expect(brouter.inFlight.some((entry) => entry.url.includes('6.6%2C45.1'))).toBe(true);
      for (const entry of [...brouter.inFlight]) entry.finish();
      await Promise.all([...busy, after].map((captured) => captured.done));
      expect(after.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('client parti pendant le calcul : requête interrompue, place rendue (BRouter tue le calcul abandonné au suivant)', async () => {
    const running = Array.from({ length: 3 }, (_, index) => call(handler, route(index)));
    const abandoned = call(handler, route(7));
    const waiting = call(handler, route(8));
    await flush();
    abandoned.close();
    await abandoned.done;
    await flush();
    expect(brouter.inFlight.some((entry) => entry.url.includes('6.7%2C45.1'))).toBe(false);
    expect(brouter.inFlight.some((entry) => entry.url.includes('6.8%2C45.1'))).toBe(true);
    for (const entry of [...brouter.inFlight]) entry.finish();
    await Promise.all([...running, waiting].map((captured) => captured.done));
  });

  it('secours (hedge=1) : une place libre ou un refus immédiat, jamais la file', async () => {
    const busy = Array.from({ length: 4 }, (_, index) => call(handler, route(index)));
    const refused = call(handler, { ...route(5), hedge: '1' });
    await refused.done;
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBeUndefined();
    brouter.inFlight[0]!.finish();
    await busy[0]!.done;
    const accepted = call(handler, { ...route(6), hedge: '1' });
    await flush();
    expect(brouter.inFlight.some((entry) => entry.url.includes('6.6%2C45.1'))).toBe(true);
    // Paramètres du proxy, jamais transmis à BRouter.
    expect(brouter.fetchMock.mock.calls.some(([url]) => /hedge|budgetMs/.test(String(url)))).toBe(false);
    expect(brouter.fetchMock.mock.calls.some(([url]) => String(url).includes('6.5%2C45.1'))).toBe(false);
    for (const entry of [...brouter.inFlight]) entry.finish();
    await Promise.all([...busy, accepted].map((captured) => captured.done));
    expect(accepted.status).toBe(200);
    expect(accepted.headers['x-brouter-budget']).toBe('1');
  });

  it('une réponse du cache ne passe pas par la file', async () => {
    const first = call(handler, route(1));
    await flush();
    brouter.inFlight[0]!.finish();
    await first.done;
    const busy = Array.from({ length: 4 }, (_, index) => call(handler, route(index + 10)));
    await flush();
    const cached = call(handler, route(1));
    await cached.done;
    expect(cached.headers['x-route-cache']).toBe('HIT');
    for (const entry of [...brouter.inFlight]) entry.finish();
    await Promise.all(busy.map((captured) => captured.done));
  });
});
