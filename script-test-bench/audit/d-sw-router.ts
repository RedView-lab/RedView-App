/**
 * Audit D — Service Worker router / handlers under miss, out-of-coverage and
 * malformed URLs. Loads the REAL public/sw-dem.js import chain (classic
 * scripts) into this realm with minimal SW globals (in-memory CacheStorage,
 * mocked network), dispatches synthetic fetch events and checks that every
 * tile request resolves to 204 (or a real tile) — never a throw, never a
 * hang, never a synthesised flat tile.
 *
 * Usage: npx tsx script-test-bench/audit/d-sw-router.ts
 * Exit 1 if any regression check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '../../public');
const ORIGIN = 'https://app.redview.test';

type AnyRec = Record<string, any>;
const g = globalThis as unknown as AnyRec;

// ── network mock ─────────────────────────────────────────────────────────
let netMode: 'offline' | '404' | 'html200' = '404';
const fetchLog: string[] = [];
g.fetch = async (input: any) => {
  const url = typeof input === 'string' ? input : input.url;
  fetchLog.push(url);
  if (url.startsWith(ORIGIN + '/france-border.json')) {
    return new Response(fs.readFileSync(path.join(PUBLIC, 'france-border.json')), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (netMode === 'offline') throw new TypeError('Failed to fetch');
  if (netMode === 'html200') return new Response('<html>captive portal</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  return new Response('not found', { status: 404 });
};

// ── CacheStorage mock (persistent-like, no eviction — same as browsers) ──
class MemCache {
  store = new Map<string, { body: ArrayBuffer; status: number; headers: [string, string][] }>();
  key(r: any) { return typeof r === 'string' ? new URL(r, ORIGIN).href : r.url; }
  async match(r: any, opts: AnyRec = {}) {
    let k = this.key(r);
    let e = this.store.get(k);
    if (!e && opts.ignoreSearch) {
      k = k.split('?')[0];
      for (const [kk, v] of this.store) if (kk.split('?')[0] === k) { e = v; break; }
    }
    return e ? new Response(e.body.byteLength ? e.body.slice(0) : null, { status: e.status, headers: e.headers }) : undefined;
  }
  async put(r: any, res: Response) {
    const body = await res.arrayBuffer();
    this.store.set(this.key(r), { body, status: res.status, headers: Array.from(res.headers.entries()) });
  }
  async add(r: any) { const res = await g.fetch(this.key(r)); await this.put(r, res); }
  async delete(r: any) { return this.store.delete(this.key(r)); }
  async keys() { return Array.from(this.store.keys()).map((u) => new Request(u)); }
}
const cacheMap = new Map<string, MemCache>();
g.caches = {
  async open(n: string) { if (!cacheMap.has(n)) cacheMap.set(n, new MemCache()); return cacheMap.get(n)!; },
  async keys() { return Array.from(cacheMap.keys()); },
  async delete(n: string) { return cacheMap.delete(n); },
  async has(n: string) { return cacheMap.has(n); },
  async match() { return undefined; },
};

// ── SW globals ───────────────────────────────────────────────────────────
const listeners: Record<string, ((e: any) => void)[]> = {};
g.self = globalThis;
g.addEventListener = (t: string, fn: any) => { (listeners[t] ||= []).push(fn); };
g.location = new URL(`${ORIGIN}/sw-dem.js?rv-map-cache-epoch=audit`);
g.clients = { matchAll: async () => [], claim: async () => {} };
g.skipWaiting = async () => {};
g.registration = { scope: ORIGIN + '/' };
const NativeRequest = globalThis.Request;
g.Request = class extends NativeRequest {
  constructor(input: any, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init);
  }
};
g.importScripts = (...urls: string[]) => {
  for (const u of urls) {
    const p = new URL(u, ORIGIN).pathname;
    const file = path.join(PUBLIC, p);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  }
};
// Browser image APIs: createImageBitmap REJECTS like a browser does on
// non-image bytes (captive portal HTML, truncated body). OffscreenCanvas is a
// permissive stub so module-level / mask code paths can run.
g.createImageBitmap = async () => { throw new DOMException('The source image could not be decoded.', 'InvalidStateError'); };
class StubCtx {
  canvas: any; constructor(c: any) { this.canvas = c; }
  getImageData(_x: number, _y: number, w: number, h: number) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  createImageData(w: number, h: number) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
}
const ctxProxy = (c: any) => new Proxy(new StubCtx(c), { get(t: any, k) { return k in t ? t[k] : () => {}; }, set(t: any, k, v) { t[k] = v; return true; } });
g.OffscreenCanvas = class { width: number; height: number; constructor(w: number, h: number) { this.width = w; this.height = h; }
  getContext() { return ctxProxy(this); }
  async convertToBlob() { throw new Error('stub OffscreenCanvas cannot encode'); } };

function pngValid(buf: Uint8Array): string {
  const b = Buffer.from(buf);
  if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47) return 'not-png';
  let off = 8; let idat = 0;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off); const type = b.subarray(off + 4, off + 8).toString('latin1');
    if (off + 12 + len > b.length) return 'truncated';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if ((globalThis as any).__crc(b.subarray(off + 4, off + 8 + len)) !== b.readUInt32BE(off + 8 + len)) return `crc(${type})`;
    if (type === 'IDAT') idat++;
    off += 12 + len;
  }
  return idat ? 'valid' : 'no-idat';
}
(globalThis as any).__crc = (await import('node:zlib')).crc32;

// silence SW console noise
const origWarn = console.warn; const origLog = console.log; const origErr = console.error;
const swLogs: string[] = [];
console.warn = (...a: any[]) => swLogs.push('W ' + a.join(' '));
console.error = (...a: any[]) => swLogs.push('E ' + a.join(' '));
console.info = console.debug = () => {};

let loadError: unknown = null;
try {
  vm.runInThisContext(fs.readFileSync(path.join(PUBLIC, 'sw-dem.js'), 'utf8'), { filename: 'sw-dem.js' });
} catch (e) { loadError = e; }
console.log = origLog;

const results: { id: string; ok: boolean; detail: string }[] = [];
function check(id: string, ok: boolean, detail: string) {
  results.push({ id, ok, detail });
  origLog(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
}
check('load sw-dem.js import chain in node', !loadError, loadError ? String(loadError) : `fetch listeners=${listeners.fetch?.length ?? 0}`);
if (loadError) { origErr(loadError); process.exit(1); }

async function dispatch(rel: string, mode: RequestMode = 'cors', timeoutMs = 25_000) {
  const req = new Request(new URL(rel, ORIGIN).href, { mode: mode === 'navigate' ? 'same-origin' : mode });
  if (mode === 'navigate') Object.defineProperty(req, 'mode', { value: 'navigate' });
  let responded: Promise<Response> | null = null;
  const ev = {
    request: req,
    respondWith(p: Promise<Response> | Response) { responded = Promise.resolve(p); },
    waitUntil() {},
  };
  let syncError: unknown = null;
  try { for (const fn of listeners.fetch || []) fn(ev); } catch (e) { syncError = e; }
  if (syncError) return { kind: 'sync-throw', error: String(syncError) };
  if (!responded) return { kind: 'passthrough' };
  const t0 = performance.now();
  try {
    const res = await Promise.race([
      responded as Promise<Response>,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    const body = await res.arrayBuffer();
    return { kind: 'response', status: res.status, len: body.byteLength, reason: res.headers.get('x-dem-reason') || res.headers.get('x-slope-reason') || res.headers.get('x-altitude-reason'), ms: performance.now() - t0, type: res.headers.get('content-type'), png: body.byteLength ? pngValid(new Uint8Array(body)) : '-', hdrs: Array.from(res.headers.keys()).join(',') };
  } catch (e) {
    return { kind: 'reject', error: String(e), ms: performance.now() - t0 };
  }
}

const isNoTile = (r: AnyRec) => r.kind === 'response' && r.status === 204;

// Single-case probe: AUDIT_ONLY="offline:/dem-tiles/12/2120/1462" AUDIT_TIMEOUT_MS=120000
async function runOnly(spec: string) {
  const [mode, url] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
  netMode = mode as typeof netMode;
  const before = fetchLog.length;
  const r: AnyRec = await dispatch(url, 'cors', Number(process.env.AUDIT_TIMEOUT_MS || 120_000));
  origLog(JSON.stringify(r), 'fetches=', fetchLog.length - before, fetchLog.slice(before, before + 5));
  origLog('last SW logs:\n  ' + swLogs.slice(-10).map((l) => l.slice(0, 200)).join('\n  '));
  check(`only ${spec}`, r.kind === 'response', `${r.kind} ${r.status ?? r.error} ${r.ms?.toFixed(0)}ms`);
}

async function run() {
  if (process.env.AUDIT_ONLY) { for (const s of process.env.AUDIT_ONLY.split("|")) await runOnly(s); return; }
  const families = ['dem', 'slope', 'altitude', 'ortho'];
  const cases: [string, string][] = [
    ['world zoom', '2/1/1'],
    ['Mont Blanc z12 (miss)', '12/2120/1462'],
    ['Mont Blanc z15 (miss)', '15/16965/11701'],
    ['x >= 2^z', '12/99999/1462'],
    ['y >= 2^z', '12/2120/99999'],
    ['z = 30', '30/0/0'],
    ['z = 99', '99/0/0'],
    ['z huge', '1024/0/0'],
    ['leading zeros', '012/02120/01462'],
    ['Pacific ocean z10', '10/100/500'],
  ];
  for (const mode of ['404', 'offline', 'html200'] as const) {
    netMode = mode;
    origLog(`\n== network=${mode} ==`);
    for (const fam of families) {
      for (const [name, c] of cases) {
        const before = fetchLog.length;
        const r: AnyRec = await dispatch(`/${fam}-tiles/${c}`);
        const fetched = fetchLog.slice(before).filter((u) => !u.includes('france-border'));
        // DEM: only 204 is acceptable (never a fake elevation). Overlays
        // (slope/altitude/ortho): 204 or a VALID transparent PNG is acceptable.
        const transparentOk = fam !== 'dem' && r.kind === 'response' && r.status === 200 && r.png === 'valid' && r.len < 200;
        const ok = isNoTile(r) || transparentOk;
        check(`${mode} ${fam} ${name}`, ok,
          `${r.kind} ${r.status ?? r.error ?? ''} len=${r.len ?? '-'} png=${r.png ?? '-'} reason=${r.reason ?? '-'} ${r.ms ? r.ms.toFixed(0) + 'ms' : ''} upstreamFetches=${fetched.length}${fetched[0] ? ' e.g. ' + fetched[0].slice(0, 110) : ''}`);
      }
    }
  }

  netMode = '404';
  origLog('\n== malformed / non-tile URLs ==');
  const malformed: [string, 'passthrough' | '204'][] = [
    ['/dem-tiles/12/2120/1462.png', 'passthrough'],
    ['/dem-tiles/12/2120', 'passthrough'],
    ['/dem-tiles/a/b/c', 'passthrough'],
    ['/dem-tiles/-1/0/0', 'passthrough'],
    ['/slope-tiles/12/2120/1462?zone=../../x', '204'],
    ['/slope-tiles/12/2120/1462?res=999999', '204'],
    ['/slope-tiles/12/2120/1462?rv-dem-profile=<script>', '204'],
    ['/radar-tiles/5/16/11?path=../../etc', '204'],
    ['/radar-tiles/5/16/11?path=/v2/radar/abc&host=https://evil.example', '204'],
    ['/radar-tiles/5/99/11?path=/v2/radar/abc', '204'],
    ['/radar-tiles/40/0/0?path=/v2/radar/abc', '204'],
    ['/shadow-tiles/12/1/1', 'passthrough'],
    ['/index.html', 'passthrough'],
  ];
  for (const [u, expect] of malformed) {
    const r: AnyRec = await dispatch(u);
    const ok = expect === 'passthrough' ? r.kind === 'passthrough' : isNoTile(r);
    check(`malformed ${u}`, ok, `${r.kind} ${r.status ?? r.error ?? ''} reason=${r.reason ?? '-'}`);
  }
  const nav: AnyRec = await dispatch('/dem-tiles/12/2120/1462', 'navigate');
  check('navigation bypasses SW', nav.kind === 'passthrough', nav.kind);

  // ── negative-cache pollution by out-of-range coordinates ──
  let negEntries = 0; let garbageKeys = 0;
  for (const [name, c] of cacheMap) {
    for (const k of c.store.keys()) {
      if (name.startsWith('dem-negative')) negEntries++;
      const m = k.match(/\/(\d+)\/(\d+)\/(\d+)/);
      if (m) { const z = +m[1], x = +m[2], y = +m[3]; if (z > 22 || x >= 2 ** z || y >= 2 ** z) garbageKeys++; }
    }
  }
  origLog(`\ncaches: ${Array.from(cacheMap.entries()).map(([n, c]) => `${n}=${c.store.size}`).join(', ')}`);
  check('no CacheStorage entries for impossible tile coords', garbageKeys === 0, `garbage keys persisted=${garbageKeys}, negative entries=${negEntries}`);

  // ── memory caches: configured caps ──
  origLog('\nmemory tier caps: ' + ['DEM_HOT_CACHE_MAX', 'DEM_HOT_CACHE_MAX_SLOPE_ACTIVE', 'SLOPE_HOT_CACHE_MAX', 'ALTITUDE_HOT_CACHE_MAX', 'ORTHO_HOT_CACHE_MAX', 'IGN_CACHE_MAX']
    .map((n) => { try { return `${n}=${vm.runInThisContext(n)}`; } catch { return `${n}=?`; } }).join(' '));
}

const hardTimer = setTimeout(() => { origErr('global timeout'); process.exit(2); }, 10 * 60_000);
await run();
clearTimeout(hardTimer);
const fails = results.filter((r) => !r.ok);
origLog(`\n${results.length} checks, ${fails.length} failure(s)`);
const errs = swLogs.filter((l) => l.startsWith('E ')).slice(0, 8);
if (errs.length) origLog('SW console.error samples:\n  ' + errs.join('\n  '));
process.exit(fails.length ? 1 : 0);
