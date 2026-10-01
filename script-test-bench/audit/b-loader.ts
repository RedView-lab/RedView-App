/**
 * Audit B — helper: load app modules (src/**) through Vite SSR so that
 * `@/` aliases and `import.meta.env` work exactly as in the app build.
 * Also provides a guarded `fetch` shim for live calls against prod:
 *   - relative `/api/...` URLs are rewritten to PROD_BASE,
 *   - every live request is counted and spaced by >= MIN_GAP_MS,
 *   - a hard cap (MAX_LIVE) prevents runaway request storms.
 */
import { createServer, type ViteDevServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROD_BASE = process.env.AUDIT_PROD_BASE ?? 'https://app.redview.tech';
export const DOWNLOADS = process.env.AUDIT_GPX_DIR ?? 'C:/Users/simon/Downloads';

let server: ViteDevServer | null = null;

export async function loadSrc<T = Record<string, unknown>>(rel: string): Promise<T> {
  if (!server) {
    server = await createServer({
      configFile: false,
      root: ROOT,
      logLevel: 'error',
      appType: 'custom',
      resolve: { alias: { '@': path.join(ROOT, 'src') } },
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      ssr: { noExternal: [] },
    });
  }
  return (await server.ssrLoadModule(path.join(ROOT, rel))) as T;
}

export async function closeLoader() {
  if (server) await server.close();
  server = null;
}

export interface LiveLog { url: string; method: string; status: number; ms: number; bytes: number; headers: Record<string, string> }

export function installLiveFetch(opts: { maxLive: number; minGapMs?: number; log?: LiveLog[] }) {
  const realFetch = globalThis.fetch;
  const minGap = opts.minGapMs ?? 3100;
  let last = 0;
  let count = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/')) url = PROD_BASE + url;
    if (count >= opts.maxLive) throw new Error(`[audit] live request cap (${opts.maxLive}) reached: ${url.slice(0, 120)}`);
    const wait = last + minGap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    count += 1;
    const t0 = performance.now();
    const res = await realFetch(url, init);
    const buf = await res.arrayBuffer();
    last = Date.now();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    opts.log?.push({ url, method: init?.method ?? 'GET', status: res.status, ms: Math.round(performance.now() - t0), bytes: buf.byteLength, headers });
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
  return { get count() { return count; }, restore() { globalThis.fetch = realFetch; } };
}
