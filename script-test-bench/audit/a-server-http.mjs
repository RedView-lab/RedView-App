#!/usr/bin/env node
// Audit A / tâche 1 — vérifications HTTP du serveur de prod (server.mjs).
//
// Usage :
//   node script-test-bench/audit/a-server-http.mjs                 # local, http://127.0.0.1:3000 (npm start sur dist/ frais)
//   node script-test-bench/audit/a-server-http.mjs --base=http://127.0.0.1:3000
//   node script-test-bench/audit/a-server-http.mjs --prod          # https://app.redview.tech, lecture seule,
//                                                                   # <= 15 requêtes, >= 3,2 s d'écart
//
// Requêtes brutes via node:http(s) (pas fetch) pour que les chemins encodés
// (`%2e%2e`, `..%2f`) arrivent tels quels au serveur.
// Sortie : tableau PASS/FAIL/INFO ; code de sortie 1 si au moins un FAIL.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const PROD = Boolean(args.prod);
const BASE = new URL(PROD ? 'https://app.redview.tech' : (args.base || 'http://127.0.0.1:3000'));
const PROD_MAX_REQUESTS = 15;
const PROD_GAP_MS = 3200;

let requestCount = 0;
let lastRequestAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Requête brute ; `body` peut être un Buffer ou un générateur de chunks (transfer-encoding chunked). */
async function raw(method, rawPath, { headers = {}, body, maxBodyBytes = 64 * 1024 } = {}) {
  if (PROD) {
    if (requestCount >= PROD_MAX_REQUESTS) throw new Error('prod request budget exhausted');
    const wait = lastRequestAt + PROD_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
  }
  requestCount += 1;
  lastRequestAt = Date.now();
  const lib = BASE.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(
      {
        method,
        host: BASE.hostname,
        port: BASE.port || (BASE.protocol === 'https:' ? 443 : 80),
        path: rawPath,
        headers: { 'user-agent': 'redview-audit-A/1.0', 'accept-encoding': 'gzip, br', ...headers },
        timeout: 20_000,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= maxBodyBytes) chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, size, body: Buffer.concat(chunks) }));
        res.on('error', (e) => resolve({ status: 0, headers: {}, size, body: Buffer.alloc(0), error: e.message }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, headers: {}, size: 0, body: Buffer.alloc(0), error: e.message }));
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      (async () => {
        try {
          for await (const chunk of body) {
            if (!req.write(chunk)) await new Promise((r) => req.once('drain', r));
          }
          req.end();
        } catch {
          req.destroy();
        }
      })();
    } else {
      if (body) req.write(body);
      req.end();
    }
  });
}

const results = [];
function record(level, id, label, detail) {
  results.push({ level, id, label, detail });
  const tag = level === 'FAIL' ? '\x1b[31mFAIL\x1b[0m' : level === 'PASS' ? '\x1b[32mPASS\x1b[0m' : level === 'WARN' ? '\x1b[33mWARN\x1b[0m' : 'INFO';
  console.log(`${tag}  ${id.padEnd(22)} ${label}${detail ? `  — ${detail}` : ''}`);
}
const check = (cond, id, label, detail) => record(cond ? 'PASS' : 'FAIL', id, label, detail);
const h = (res, name) => res.headers[name.toLowerCase()];
// Corps décodé selon Content-Encoding (le serveur compresse désormais les statiques).
function decodedBody(res) {
  const enc = h(res, 'content-encoding');
  try {
    if (enc === 'br') return zlib.brotliDecompressSync(res.body);
    if (enc === 'gzip') return zlib.gunzipSync(res.body);
    if (enc === 'deflate') return zlib.inflateSync(res.body);
  } catch {
    // corps tronqué (maxBodyBytes) : on garde les octets bruts
  }
  return res.body;
}
const isHtmlBody = (res) => /^\s*<!doctype html/i.test(decodedBody(res).toString('utf8', 0, 64));

function securityHeaders(res, id, { expectCsp }) {
  const missing = [];
  for (const name of ['x-content-type-options', 'referrer-policy', 'strict-transport-security', 'permissions-policy']) {
    if (!h(res, name)) missing.push(name);
  }
  if (expectCsp) {
    if (!h(res, 'content-security-policy')) missing.push('content-security-policy');
    if (!h(res, 'x-frame-options') && !/frame-ancestors/.test(h(res, 'content-security-policy') || '')) missing.push('x-frame-options/frame-ancestors');
  }
  check(missing.length === 0, `${id}.sec`, 'security headers', missing.length ? `missing: ${missing.join(', ')}` : 'ok');
}

function longCached(cc) {
  const m = /max-age=(\d+)/.exec(cc || '');
  return Boolean(m && Number(m[1]) > 3600) || /immutable/.test(cc || '');
}

async function main() {
  console.log(`# a-server-http — target ${BASE.origin}${PROD ? ' (PROD, read-only, budget 15 req)' : ''}\n`);

  // ── 1. Documents HTML ────────────────────────────────────────────────────
  const home = await raw('GET', '/');
  check(home.status === 200 && isHtmlBody(home), 'html./', 'GET / → 200 HTML', `status=${home.status}`);
  securityHeaders(home, 'html./', { expectCsp: true });
  check(/no-store|no-cache/.test(h(home, 'cache-control') || ''), 'html./.cache', 'index.html not cached', `cache-control=${h(home, 'cache-control')}`);
  const csp = h(home, 'content-security-policy') || '';
  record('INFO', 'html./.csp', 'CSP length / unsafe-eval', `${csp.length} chars; unsafe-eval=${/'unsafe-eval'/.test(csp)}; frame-ancestors=${/frame-ancestors 'none'/.test(csp)}`);
  record('INFO', 'html./.enc', 'content-encoding / etag / last-modified', `${h(home, 'content-encoding') || 'none'} / ${h(home, 'etag') || 'none'} / ${h(home, 'last-modified') || 'none'}`);

  const html = decodedBody(home).toString('utf8');
  const entry = /<script[^>]+type="module"[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  const css = /<link[^>]+rel="stylesheet"[^>]+href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
  record('INFO', 'html./.entry', 'entry chunk', entry || 'NOT FOUND');

  const viewer = await raw('GET', '/viewer');
  check(viewer.status === 200 && isHtmlBody(viewer) && /viewer/i.test(decodedBody(viewer).toString()), 'html./viewer', 'GET /viewer → viewer.html', `status=${viewer.status}`);
  securityHeaders(viewer, 'html./viewer', { expectCsp: true });
  check(/no-store|no-cache/.test(h(viewer, 'cache-control') || ''), 'html./viewer.cache', 'viewer.html not cached', `cache-control=${h(viewer, 'cache-control')}`);

  // ── 2. Assets hashés ─────────────────────────────────────────────────────
  if (entry) {
    const asset = await raw('GET', entry, { maxBodyBytes: 8 * 1024 * 1024 });
    // Corps décompressé : nom du gros chunk préchargé + présence du bouton démo
    try {
      const enc = h(asset, 'content-encoding');
      const { gunzipSync, brotliDecompressSync, inflateSync } = await import('node:zlib');
      const js = (enc === 'gzip' ? gunzipSync(asset.body) : enc === 'br' ? brotliDecompressSync(asset.body) : enc === 'deflate' ? inflateSync(asset.body) : asset.body).toString('utf8');
      record('INFO', 'asset.entry.demo', '"Continue with Demo account" in entry chunk', String(js.includes('Continue with Demo account')));
      const deps = /m\.f\|\|\(m\.f=\[([^\]]*)\]\)/.exec(js)?.[1] || '';
      const heavy = /"(assets\/lazParser-[^"]+\.js)"/.exec(deps)?.[1];
      if (heavy) {
        const hr = await raw('HEAD', '/' + heavy);
        record('INFO', 'asset.lazParser', `HEAD /${heavy} (Dashboard preload dep)`, `status=${hr.status} content-length=${h(hr, 'content-length') || '?'} enc=${h(hr, 'content-encoding') || 'none'} cache-control=${h(hr, 'cache-control')}`);
      }
    } catch (e) {
      record('INFO', 'asset.entry.body', 'entry body inspection failed', e.message);
    }
    check(asset.status === 200 && /javascript/.test(h(asset, 'content-type') || ''), 'asset.entry', `GET ${entry}`, `status=${asset.status} type=${h(asset, 'content-type')} size=${asset.size} enc=${h(asset, 'content-encoding') || 'none'}`);
    check(/immutable/.test(h(asset, 'cache-control') || '') && longCached(h(asset, 'cache-control')), 'asset.entry.cache', 'hashed JS immutable', `cache-control=${h(asset, 'cache-control')}`);
    securityHeaders(asset, 'asset.entry', { expectCsp: false });
  }
  if (css && !PROD) {
    const asset = await raw('GET', css, { maxBodyBytes: 1 });
    check(/immutable/.test(h(asset, 'cache-control') || ''), 'asset.css.cache', `hashed CSS immutable (${css})`, `cache-control=${h(asset, 'cache-control')}`);
  }

  // Worker chunks hashés : servis en no-cache (heuristique `includes('worker')`)
  if (!PROD) {
    const workerChunk = fs.readdirSync(path.join(ROOT, 'dist/assets')).find((f) => /worker/i.test(f) && f.endsWith('.js'));
    if (workerChunk) {
      const w = await raw('GET', `/assets/${workerChunk}`, { maxBodyBytes: 1 });
      record(longCached(h(w, 'cache-control')) ? 'PASS' : 'WARN', 'asset.worker.cache', `hashed worker chunk /assets/${workerChunk}`, `cache-control=${h(w, 'cache-control')} (hashed but revalidated every load)`);
    }
  }

  // ── 3. Service worker ────────────────────────────────────────────────────
  const sw = await raw('GET', '/sw-dem.js', { maxBodyBytes: 2048 });
  check(sw.status === 200 && /javascript/.test(h(sw, 'content-type') || ''), 'sw./sw-dem.js', 'GET /sw-dem.js → JS', `status=${sw.status} type=${h(sw, 'content-type')}`);
  check(!longCached(h(sw, 'cache-control')), 'sw./sw-dem.js.cache', 'sw-dem.js not long-cached', `cache-control=${h(sw, 'cache-control')}`);
  const stamp = /cache[^\n]{0,80}/i.exec(sw.body.toString('utf8'))?.[0];
  record('INFO', 'sw./sw-dem.js.stamp', 'header stamp', (stamp || '').trim().slice(0, 100));
  if (!PROD) {
    const swDir = path.join(ROOT, 'dist/sw-dem');
    const sub = fs.readdirSync(swDir, { recursive: true }).map(String).find((f) => f.endsWith('.js'));
    if (sub) {
      const r = await raw('GET', `/sw-dem/${sub.replace(/\\/g, '/')}`, { maxBodyBytes: 1 });
      check(!longCached(h(r, 'cache-control')) && r.status === 200, 'sw.module.cache', `/sw-dem/${sub.replace(/\\/g, '/')} not long-cached`, `status=${r.status} cache-control=${h(r, 'cache-control')}`);
    }
  }

  // ── 4. SPA fallback vs asset manquant ────────────────────────────────────
  const missing = await raw('GET', '/assets/nonexistent-xyz.js');
  check(
    missing.status === 404,
    'asset.missing',
    'missing /assets/*.js → 404 (not index.html)',
    `status=${missing.status} type=${h(missing, 'content-type')} cache-control=${h(missing, 'cache-control')} htmlBody=${isHtmlBody(missing)}`,
  );
  if (!PROD) {
    const missingCss = await raw('GET', '/assets/Dashboard-OLDHASH.css');
    check(missingCss.status === 404, 'asset.missing.css', 'missing /assets/*.css → 404', `status=${missingCss.status} type=${h(missingCss, 'content-type')}`);
    const missingWasm = await raw('GET', '/missing-file.wasm');
    check(missingWasm.status === 404, 'static.missing.wasm', 'missing /*.wasm → 404', `status=${missingWasm.status} type=${h(missingWasm, 'content-type')}`);
    const spa = await raw('GET', '/p/some-project-id/whatever');
    check(spa.status === 200 && isHtmlBody(spa) && /no-store/.test(h(spa, 'cache-control') || ''), 'spa.fallback', 'unknown route → index.html (no-store)', `status=${spa.status} cache-control=${h(spa, 'cache-control')}`);
    check(Boolean(h(spa, 'content-security-policy')), 'spa.fallback.csp', 'SPA fallback carries CSP', '');

    // Fichiers racine non hashés et volumineux : pas de Cache-Control ni validateur
    for (const p of ['/redviewalgo_bg.wasm', '/laz-perf.wasm', '/france-border.json']) {
      const r = await raw('HEAD', p);
      const cc = h(r, 'cache-control');
      record(cc || h(r, 'etag') || h(r, 'last-modified') ? 'INFO' : 'WARN', `static${p}`, `root static ${p}`, `status=${r.status} len=${h(r, 'content-length') || '?'} cache-control=${cc || 'none'} etag=${h(r, 'etag') || 'none'} last-modified=${h(r, 'last-modified') || 'none'}`);
    }
  }

  // ── 5. Traversal / fichiers sensibles ────────────────────────────────────
  const leakRe = /APPWRITE_API_KEY|STRIPE_SECRET|import http from 'node:http'|BROUTER_UPSTREAM|\"devDependencies\"/;
  const traversal = PROD
    ? ['/assets/..%2fserver.mjs', '/%2e%2e/.env', '/api/_lib/appwrite']
    : [
        '/assets/..%2fserver.mjs',
        '/assets/..%2f..%2fserver.mjs',
        '/%2e%2e/.env',
        '/%2e%2e/package.json',
        '/.env',
        '/..%5cserver.mjs',
        '/assets/%2e%2e/%2e%2e/package.json',
        '/%00.html',
        '/api/_lib/x',
        '/api/_lib/appwrite',
        '/api/..%2f_lib%2fappwrite',
        '/api/%2e%2e/server',
        '/api/auth/..%2f_lib/appwrite',
        '/api/brouter/..%2f..%2fserver',
        '/server.mjs',
        '/package.json',
      ];
  for (const p of traversal) {
    const r = await raw('GET', p);
    const leaked = leakRe.test(decodedBody(r).toString('utf8'));
    const ok = !leaked && (r.status >= 400 || isHtmlBody(r));
    check(ok, `trav.${p}`.slice(0, 22), `GET ${p}`, `status=${r.status} type=${h(r, 'content-type') || '-'} leak=${leaked} body=${JSON.stringify(r.body.toString('utf8', 0, 60))}`);
  }

  // ── 6. Corps volumineux (bodyLimitFor) ───────────────────────────────────
  if (!PROD) {
    const big = (n) => Buffer.alloc(n, 0x61);
    // Content-Length déclaré > limite → 413 immédiat
    const fb = await raw('POST', '/api/projects/share', { headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 10) }, body: big(1024 * 1024 + 10) });
    check(fb.status === 413, 'body.share.1MB+', 'POST /api/projects/share 1 MiB+10 B → 413', `status=${fb.status} body=${fb.body.toString().slice(0, 60)}`);
    const poi = await raw('POST', '/api/poi', { headers: { 'content-type': 'application/json', 'content-length': String(512 * 1024 + 1) }, body: big(512 * 1024 + 1) });
    check(poi.status === 413, 'body.poi.512K+', 'POST /api/poi 512 KiB+1 → 413', `status=${poi.status}`);
    const brouter = await raw('POST', '/api/brouter/profile', { headers: { 'content-type': 'text/plain', 'content-length': String(600 * 1024) }, body: big(600 * 1024) });
    check(brouter.status === 413, 'body.brouter.600K', 'POST /api/brouter/* 600 KiB → 413 (alias limit)', `status=${brouter.status}`);
    // Chunked sans Content-Length : 4 MiB en flux → doit être coupé à 1 MiB
    async function* chunks() {
      for (let i = 0; i < 64; i++) yield big(64 * 1024);
    }
    const t0 = Date.now();
    const chunked = await raw('POST', '/api/projects/share', { headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, body: chunks() });
    check(chunked.status === 413 || chunked.status === 0, 'body.chunked.4MB', 'POST chunked 4 MiB (no length) → 413', `status=${chunked.status}${chunked.error ? ` err=${chunked.error}` : ''} in ${Date.now() - t0} ms`);
    // Petite requête mal formée : vérifier qu'on n'obtient pas un 500 avec stack
    const bad = await raw('POST', '/api/projects/share', { headers: { 'content-type': 'application/json' }, body: Buffer.from('{not json') });
    record(bad.status === 500 ? 'WARN' : 'INFO', 'body.badjson', 'POST /api/projects/share invalid JSON', `status=${bad.status} body=${bad.body.toString().slice(0, 100)}`);
  }

  // ── 7. HEAD / OPTIONS / méthodes ─────────────────────────────────────────
  if (!PROD) {
    const head = await raw('HEAD', '/');
    check(head.status === 200 && head.size === 0, 'method.HEAD./', 'HEAD / → 200 without body', `status=${head.status} bodyBytes=${head.size} cc=${h(head, 'cache-control')}`);
    const headAsset = entry ? await raw('HEAD', entry) : null;
    if (headAsset) check(headAsset.status === 200 && headAsset.size === 0, 'method.HEAD.asset', 'HEAD hashed asset', `status=${headAsset.status} bodyBytes=${headAsset.size}`);
    const opt = await raw('OPTIONS', '/');
    record('INFO', 'method.OPTIONS./', 'OPTIONS /', `status=${opt.status} allow=${h(opt, 'allow') || '-'} type=${h(opt, 'content-type')} bytes=${opt.size}`);
    const optApi = await raw('OPTIONS', '/api/app-translations');
    record('INFO', 'method.OPTIONS.api', 'OPTIONS /api/app-translations', `status=${optApi.status} acao=${h(optApi, 'access-control-allow-origin') || '-'} bytes=${optApi.size}`);
    const post = await raw('POST', '/', { body: Buffer.from('x') });
    record(post.status === 200 ? 'WARN' : 'INFO', 'method.POST./', 'POST / (static)', `status=${post.status} (static files answer any method)`);
    const del = await raw('DELETE', '/assets/' + (entry || '').split('/').pop());
    record(del.status === 200 ? 'WARN' : 'INFO', 'method.DELETE.asset', 'DELETE hashed asset', `status=${del.status}`);
    const health = await raw('GET', '/api/health');
    check(health.status === 200, 'health', 'GET /api/health', `status=${health.status} body=${health.body.toString().slice(0, 80)}`);
    const apiMissing = await raw('GET', '/api/does-not-exist');
    check(apiMissing.status === 404, 'api.missing', 'GET /api/does-not-exist → 404 JSON', `status=${apiMissing.status} type=${h(apiMissing, 'content-type')}`);
  }

  // ── 8. Prod uniquement : wasm racine ─────────────────────────────────────
  if (PROD) {
    const r = await raw('HEAD', '/redviewalgo_bg.wasm');
    record('INFO', 'static./redviewalgo', 'HEAD /redviewalgo_bg.wasm', `status=${r.status} cache-control=${h(r, 'cache-control') || 'none'} etag=${h(r, 'etag') || 'none'} last-modified=${h(r, 'last-modified') || 'none'}`);
  }

  const fails = results.filter((r) => r.level === 'FAIL');
  const warns = results.filter((r) => r.level === 'WARN');
  console.log(`\n${results.length} checks, ${fails.length} FAIL, ${warns.length} WARN, ${requestCount} requests`);
  if (args.json) fs.writeFileSync(String(args.json), JSON.stringify({ base: BASE.origin, results }, null, 2));
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
