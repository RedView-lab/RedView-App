/**
 * Shim `fetch` : les appels relatifs `/api/brouter…` de l'app sont servis par
 * le vrai handler `api/brouter.ts`, exécuté dans ce process (mock req/res),
 * qui parle à BRouter via `BROUTER_UPSTREAM` (tunnel SSH vers le VPS).
 * Client + proxy sont donc testés tels qu'en prod, sans le rate-limit public.
 *
 * Toutes les requêtes amont passent par une file : `maxConcurrent` (1 par
 * défaut) pour ne jamais saturer les 4 threads BRouter de prod.
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import zlib from 'node:zlib';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

export interface UpstreamLogEntry {
  method: string;
  path: string;
  status: number;
  ms: number;
  /** Temps jusqu'aux en-têtes : BRouter ne répond qu'une fois le tracé calculé. */
  ttfbMs: number;
  /** Téléchargement du corps (dépend du tunnel, pas du routage). */
  transferMs: number;
}

export interface ProxyShim {
  log: UpstreamLogEntry[];
  restore(): void;
}

export function installProxyShim(handler: Handler, opts: { maxConcurrent?: number } = {}): ProxyShim {
  const realFetch = globalThis.fetch;
  const log: UpstreamLogEntry[] = [];
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? 1);
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = async () => {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = () => {
    active -= 1;
    waiters.shift()?.();
  };

  // Appels amont du handler (vers BRouter) : sérialisés + journalisés.
  const upstreamFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    await acquire();
    const t0 = performance.now();
    try {
      const timing = { ttfb: Number.NaN };
      const res = await httpRequest(url, init, timing);
      const ms = Math.round(performance.now() - t0);
      const ttfbMs = Math.round(timing.ttfb - t0);
      log.push({ method: init?.method ?? 'GET', path: describe(url), status: res.status, ms, ttfbMs, transferMs: ms - ttfbMs });
      return res;
    } catch (error) {
      // Requête annulée (secours gagnant, timeout client) : journalisée avec le statut 0.
      const ms = Math.round(performance.now() - t0);
      log.push({ method: init?.method ?? 'GET', path: describe(url), status: 0, ms, ttfbMs: ms, transferMs: 0 });
      throw error;
    } finally {
      release();
    }
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('/api/brouter')) return upstreamFetch(input, init);
    return callHandler(handler, url, init);
  }) as typeof fetch;

  return {
    log,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

function describe(url: string): string {
  const pathname = url.replace(/^https?:\/\/[^/]+/, '');
  const pass1 = /profile(?:%3A|:)pass1coefficient=[\d.]+/.exec(pathname)?.[0] ?? '';
  return `${pathname.slice(0, 120)} ${pass1}`;
}

/**
 * `node:http` sans keep-alive : à travers le tunnel SSH, undici (fetch) plante
 * par assertion interne quand BRouter ferme une connexion réutilisée.
 */
function httpRequest(url: string, init: RequestInit | undefined, timing: { ttfb: number }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    // Comme le fetch du proxy en prod : réponse BRouter compressée (le tunnel est lent).
    headers['accept-encoding'] = 'gzip';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    if (body != null) headers['content-length'] = String(Buffer.byteLength(body));
    const req = http.request(url, { method: init?.method ?? 'GET', headers, agent: false }, (res) => {
      timing.ttfb = performance.now();
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value != null && key !== 'content-encoding' && key !== 'content-length') {
            responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
        }
        let body = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
        resolve(new Response(body, { status: res.statusCode ?? 502, statusText: res.statusMessage, headers: responseHeaders }));
      });
    });
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }
    req.end(body);
  });
}

async function callHandler(handler: Handler, url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url, 'http://local');
  const query: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? init.body : init?.body == null ? undefined : String(init.body);
  const signal = init?.signal ?? undefined;

  return new Promise<Response>((resolve, reject) => {
    const headers = new Headers();
    let statusCode = 200;
    let finished = false;
    const emitter = new EventEmitter();
    const finish = (payload: unknown) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      // Le navigateur décompresse la réponse du proxy (Content-Encoding).
      const encoding = headers.get('content-encoding');
      let raw: Buffer | string = payload == null ? '' : Buffer.isBuffer(payload) ? payload : typeof payload === 'string' ? payload : String(payload);
      if (Buffer.isBuffer(raw) && encoding === 'br') raw = zlib.brotliDecompressSync(raw);
      else if (Buffer.isBuffer(raw) && encoding === 'gzip') raw = zlib.gunzipSync(raw);
      headers.delete('content-encoding');
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
      resolve(new Response(statusCode === 204 ? null : text, { status: statusCode, headers }));
    };
    const res = Object.assign(emitter, {
      get writableFinished() {
        return finished;
      },
      get statusCode() {
        return statusCode;
      },
      setHeader(name: string, value: string | number) {
        headers.set(name, String(value));
        return res;
      },
      getHeader(name: string) {
        return headers.get(name) ?? undefined;
      },
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(data: unknown) {
        if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
        finish(JSON.stringify(data));
        return res;
      },
      send(data: unknown) {
        finish(data);
        return res;
      },
      end(data?: unknown) {
        finish(data ?? '');
        return res;
      },
    });
    const req = { method, url, query, body, headers: { 'content-type': init?.headers ? 'text/plain' : undefined, 'accept-encoding': 'gzip, deflate, br' } };

    // Client parti (timeout 14 s côté app, abandon) : comme en prod, le
    // handler voit `close` et coupe sa requête amont.
    const onAbort = () => {
      if (finished) return;
      emitter.emit('close');
      finished = true;
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    handler(req, res).catch((error) => {
      if (finished) return;
      finished = true;
      reject(error);
    });
  });
}
