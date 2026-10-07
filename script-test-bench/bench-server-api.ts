/**
 * RedView Test-Bench : serveur de prod (server.mjs) et ses primitives de sécurité.
 *
 * Tout passe par le vrai code :
 * 1. primitives partagées par les deux adaptateurs (server/http-security.mjs,
 *    server/byte-lru.mjs, server/request-logging.mjs) : chaîne de sécurité d'une
 *    requête API (chemin, route, IP client, clé et quota de rate limit), flot
 *    d'IP distinctes (Map bornée), cache de tuiles borné en octets, tuiles et
 *    upstream LiDAR — avec leurs invariants vérifiés avant de mesurer ;
 * 2. le serveur bundlé lancé pour de vrai (`node dist-server/server.mjs`, comme
 *    l'image) : débit et latences par type de réponse (health, index.html,
 *    plus gros chunk brotli, 304, SPA, 404, route API, tuile 204, chemins
 *    hostiles), octets envoyés, lignes de journal, quota API à la 121ᵉ requête,
 *    mémoire du processus.
 *
 *   npm run bench:server [-- --quick] [--no-http] [--root <checkout>] [--json <fichier>]
 *
 * `--root` vise une autre copie (ex. HEAD extraite par `git archive`, avec son
 * dist/ et son dist-server/) pour un avant/après sur la même machine.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { pathToFileURL } from 'node:url';

import type * as ByteLruModule from '../server/byte-lru.mjs';
import type * as HttpSecurityModule from '../server/http-security.mjs';
import type * as RequestLoggingModule from '../server/request-logging.mjs';
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';

const REPO = path.resolve(import.meta.dirname, '..');

/** Modules serveur de la copie mesurée (`--root`) : HEAD et arbre de travail passent par leur propre code. */
type ServerModules = {
  apiDir: string;
  security: typeof HttpSecurityModule;
  lru: typeof ByteLruModule;
  logging: typeof RequestLoggingModule;
};

async function loadServerModules(root: string): Promise<ServerModules> {
  const load = (relative: string) => import(pathToFileURL(path.join(root, relative)).href);
  return {
    apiDir: path.join(root, 'api'),
    security: await load('server/http-security.mjs'),
    lru: await load('server/byte-lru.mjs'),
    logging: await load('server/request-logging.mjs'),
  };
}

type FakeRequest = { socket: { remoteAddress: string }; headers: Record<string, string> };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[bench:server] invariant violé : ${message}`);
}

// ── 1. Primitives ────────────────────────────────────────────────────────────

/** Requêtes telles que les voit le conteneur derrière le nginx de l'hôte (pair 172.x, XFF = client). */
function buildApiTraffic(count: number) {
  const paths = [
    '/api/brouter/route',
    '/api/poi',
    '/api/weather/tiles/temp/2026100612/6/32/22.png',
    '/api/openmeteo/v1/forecast',
    '/api/auth/forgot-password',
    '/api/projects/share',
    '/api/does-not-exist',
    '/api/_lib/i18n',
    '/api/..%2f..%2fserver.mjs',
    '/api/app-translations',
  ];
  const traffic: Array<{ rawPath: string; req: FakeRequest }> = [];
  for (let i = 0; i < count; i++) {
    const v6 = i % 7 === 0;
    const client = v6 ? `2a01:e0a:${(i % 97).toString(16)}:${(i % 13).toString(16)}::${(i % 50).toString(16)}` : `81.${i % 200}.${(i >> 3) % 250}.${i % 250}`;
    const headers: Record<string, string> = { 'x-forwarded-for': client };
    // CF-Connecting-IP falsifié : ignoré, le pair n'est pas une IP Cloudflare.
    if (i % 5 === 0) headers['cf-connecting-ip'] = '198.51.100.42';
    traffic.push({ rawPath: paths[i % paths.length], req: { socket: { remoteAddress: '::ffff:172.18.0.1' }, headers } });
  }
  return traffic;
}

function checkSecurityInvariants(m: ServerModules, routes: Set<string>) {
  const { createRateLimiter, decodeSafePathname, getClientIp, parseTileCoords, rateLimitKeyForIp, resolveApiRoute, resolvePointcloudUpstream } = m.security;
  const API_DIR = m.apiDir;
  const resolve = (p: string) => {
    const decoded = decodeSafePathname(p);
    return decoded === null ? 'invalid' : resolveApiRoute(API_DIR, decoded, { extension: '.ts', routes })?.route ?? null;
  };
  assert(resolve('/api/brouter/route') === 'brouter', 'alias brouter');
  assert(resolve('/api/weather/tiles/a/b') === 'weather', 'alias weather');
  assert(resolve('/api/auth/forgot-password') === 'auth/forgot-password', 'route imbriquée');
  assert(resolve('/api/_lib/i18n') === null, '_lib jamais servi');
  assert(resolve('/api/..%2f..%2fserver.mjs') === 'invalid', '.. encodé refusé');
  assert(resolve('/assets/%2e%2e/%2e%2e/package.json') === 'invalid', '%2e%2e refusé');
  assert(resolve('/x%00') === 'invalid', 'octet nul refusé');
  const spoofed: FakeRequest = { socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-forwarded-for': '6.6.6.6, 81.1.2.3', 'cf-connecting-ip': '1.1.1.1' } };
  assert(getClientIp(spoofed) === '81.1.2.3', 'XFF le plus à droite, CF ignoré hors Cloudflare');
  assert(getClientIp({ socket: { remoteAddress: '81.9.9.9' }, headers: { 'x-forwarded-for': '1.2.3.4' } }) === '81.9.9.9', 'XFF ignoré d\'un pair public');
  assert(rateLimitKeyForIp('2a01:e0a:1:2::5') === rateLimitKeyForIp('2a01:e0a:1:2:ffff::1'), 'IPv6 groupée par /64');
  const hit = createRateLimiter({ windowMs: 60_000 });
  let allowed = 0;
  for (let i = 0; i < 125; i++) if (hit('k', 120)) allowed++;
  assert(allowed === 120, `quota 120/min (${allowed})`);
  assert(parseTileCoords('/slope-tiles/23/1/1.png', /^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)/) === null, 'zoom > 22 refusé');
  assert(parseTileCoords('/slope-tiles/2/4/1.png', /^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)/) === null, 'x hors grille refusé');
  assert(resolvePointcloudUpstream('https://geotiles.citg.tudelft.nl/AHN5_T/37EN1_01.LAZ') !== null, 'upstream AHN autorisé');
  assert(resolvePointcloudUpstream('https://geotiles.citg.tudelft.nl:8443/AHN5_T/37EN1_01.LAZ') === null, 'port refusé');
  assert(resolvePointcloudUpstream('https://evil.example/AHN5_T/37EN1_01.LAZ') === null, 'hôte refusé');
}

function runPrimitives(m: ServerModules, suite: BenchmarkSuite, iterations: number) {
  const { createRateLimiter, decodeSafePathname, getClientIp, listApiRoutes, parseTileCoords, rateLimitKeyForIp, resolveApiRoute, resolvePointcloudUpstream } = m.security;
  const { createByteLru } = m.lru;
  const { normalizeRoutePath } = m.logging;
  const API_DIR = m.apiDir;
  const routes = listApiRoutes(API_DIR, '.ts');
  checkSecurityInvariants(m, routes);

  // Chaîne complète d'une requête API, dans l'ordre de server.mjs.
  const traffic = buildApiTraffic(10_000);
  suite.measureSync(
    {
      name: 'Chaîne sécurité requête API (10k)',
      category: 'server-security',
      iterations,
      regressionThresholdP95Ms: 80,
      itemsProcessedPerOp: traffic.length,
    },
    () => {
      const hit = createRateLimiter({ windowMs: 60_000 });
      let accepted = 0;
      for (const { rawPath, req } of traffic) {
        const pathname = decodeSafePathname(rawPath);
        if (pathname === null) continue;
        const apiRoute = resolveApiRoute(API_DIR, pathname, { extension: '.ts', routes });
        normalizeRoutePath(pathname, apiRoute?.route);
        const bucket = apiRoute?.isAuth ? 'auth' : 'general';
        if (hit(`${rateLimitKeyForIp(getClientIp(req))}:${bucket}`, apiRoute?.isAuth ? 15 : 120) && apiRoute) accepted++;
      }
      return accepted;
    },
  );

  // Flot d'IP toutes différentes : la Map du rate limiter reste bornée (maxKeys), éviction en tête en O(1)
  // amorti (server/oldest-key.mjs ; avec `keys().next()`, 250-410 ms ici : ~10 µs par éviction à 50k clés).
  suite.measureSync(
    {
      name: 'Rate limit, 100k IP distinctes (borne 50k)',
      category: 'server-rate-limit',
      iterations: Math.max(3, Math.floor(iterations / 2)),
      regressionThresholdP95Ms: 120,
      itemsProcessedPerOp: 100_000,
    },
    () => {
      const hit = createRateLimiter({ windowMs: 60_000, maxKeys: 50_000 });
      let allowed = 0;
      for (let i = 0; i < 100_000; i++) {
        if (hit(`${(i >>> 16) & 255}.${(i >>> 8) & 255}.${i & 255}.7:general`, 120)) allowed++;
      }
      return allowed;
    },
  );

  // Cache de tuiles borné en octets (fallbacks pente/altitude, BRouter) : 80 % de lectures, accès concentrés.
  const tilePool = [8, 16, 24, 40, 60].map((kib) => Buffer.alloc(kib * 1024, 7));
  const lru = createByteLru<Buffer>({ maxBytes: 64 * 1024 * 1024, sizeOf: (value) => value.length });
  let state = 12345;
  const nextRandom = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  let hits = 0;
  let reads = 0;
  suite.measureSync(
    {
      name: 'Cache LRU octets tuiles (10k ops, 64 Mo)',
      category: 'server-cache',
      iterations,
      regressionThresholdP95Ms: 10,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      for (let i = 0; i < 10_000; i++) {
        // Distribution concentrée (≈ Zipf) sur 20 000 tuiles : quelques zones très demandées.
        const tile = Math.floor(20_000 * nextRandom() ** 3);
        const key = `slope:12/${2000 + (tile % 150)}/${1400 + Math.floor(tile / 150)}`;
        if (nextRandom() < 0.8) {
          reads++;
          if (lru.get(key)) hits++;
        } else {
          lru.set(key, tilePool[tile % tilePool.length]);
        }
      }
      return lru.size;
    },
  );
  assert(lru.bytes <= 64 * 1024 * 1024, `LRU au-delà de son budget (${lru.bytes})`);

  const tileRe = /^\/(?:slope|altitude|radar)-tiles\/(\d+)\/(\d+)\/(\d+)/;
  const tilePaths = Array.from({ length: 10_000 }, (_, i) => `/${['slope', 'altitude', 'radar'][i % 3]}-tiles/${8 + (i % 14)}/${i % 200}/${(i * 7) % 200}.png`);
  suite.measureSync(
    {
      name: 'Tuiles : coordonnées + route normalisée (10k)',
      category: 'server-tiles',
      iterations,
      regressionThresholdP95Ms: 8,
      itemsProcessedPerOp: tilePaths.length,
    },
    () => {
      let valid = 0;
      for (const p of tilePaths) {
        if (parseTileCoords(p, tileRe)) valid++;
        normalizeRoutePath(p);
      }
      return valid;
    },
  );

  const upstreams = Array.from({ length: 2_000 }, (_, i) => (i % 4 === 0
    ? `https://evil.example/AHN5_T/${i}.LAZ`
    : `https://geotiles.citg.tudelft.nl/AHN5_T/${String(10 + (i % 80)).padStart(2, '0')}${'ABCDEFGH'[i % 8]}N${1 + (i % 2)}_${String(i % 25).padStart(2, '0')}.LAZ`));
  suite.measureSync(
    {
      name: 'Allowlist upstream LiDAR (2k URL)',
      category: 'server-security',
      iterations,
      regressionThresholdP95Ms: 5,
      itemsProcessedPerOp: upstreams.length,
    },
    () => upstreams.filter((url) => resolvePointcloudUpstream(url) !== null).length,
  );

  return { lruHitRate: reads > 0 ? hits / reads : 0 };
}

// ── 2. Serveur bundlé ───────────────────────────────────────────────────────

type Sample = { status: number; bytes: number; ms: number; headers: http.IncomingHttpHeaders };
type ScenarioResult = {
  name: string;
  requests: number;
  reqPerSec: number;
  p50: number;
  p95: number;
  p99: number;
  bytesPerResponse: number;
  encoding: string;
  unexpected: number;
  logLinesPerRequest: number;
  rssAfterMb: number | null;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function request(port: number, agent: http.Agent, pathname: string, headers: Record<string, string>): Promise<Sample> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers, agent }, (res) => {
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes, ms: performance.now() - t0, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`délai dépassé : ${pathname}`)));
  });
}

function processRssMb(pid: number): number | null {
  try {
    if (process.platform === 'linux') {
      const match = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      return match ? Number(match[1]) / 1024 : null;
    }
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout;
      // Dernière colonne : « 85 432 K » (anglais) ou « 85 432 Ko » (français).
      const kib = /"([^"]+) K[oB]?"\s*$/.exec(out.trim())?.[1]?.replace(/[^\d]/g, '');
      return kib ? Number(kib) / 1024 : null;
    }
  } catch {
    // Mesure facultative.
  }
  return null;
}

async function startServer(root: string) {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error(`${root}/dist absent : lancer \`vite build\` d'abord`);
  // Bundle reconstruit s'il manque ou s'il est plus ancien que ses sources (server.mjs, server/*.mjs).
  const bundle = path.join(root, 'dist-server', 'server.mjs');
  const newestSource = Math.max(
    fs.statSync(path.join(root, 'server.mjs')).mtimeMs,
    ...fs.readdirSync(path.join(root, 'server')).filter((name) => name.endsWith('.mjs')).map((name) => fs.statSync(path.join(root, 'server', name)).mtimeMs),
  );
  if (!fs.existsSync(bundle) || fs.statSync(bundle).mtimeMs < newestSource) {
    const built = spawnSync(process.execPath, ['scripts/build/build-server.mjs'], { cwd: root, stdio: 'inherit' });
    if (built.status !== 0) throw new Error('build-server a échoué');
  }
  const assets = path.join(root, 'dist', 'assets');
  if (!fs.readdirSync(assets).some((name) => name.endsWith('.br'))) {
    const packed = spawnSync(process.execPath, ['scripts/build/precompress-dist.mjs', 'dist'], { cwd: root, stdio: 'inherit' });
    if (packed.status !== 0) throw new Error('precompress-dist a échoué');
  }
  const port = await freePort();
  const child = spawn(process.execPath, ['dist-server/server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production', SENTRY_DSN_SERVER: '', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logLines = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    for (const byte of chunk) if (byte === 10) logLines++;
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk;
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await request(port, agent, '/health', {})).status === 200) break;
    } catch {
      // Pas encore à l'écoute.
    }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server.mjs ne démarre pas\n${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const largest = fs.readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, size: fs.statSync(path.join(assets, name)).size }))
    .sort((a, b) => b.size - a.size)[0];
  return {
    port,
    agent,
    largest,
    logLines: () => logLines,
    rssMb: () => processRssMb(child.pid ?? 0),
    stop: () => {
      agent.destroy();
      child.kill();
    },
  };
}

let ipCounter = 0;
/** Chaque requête vient d'un client différent (XFF posé par le proxy de l'hôte), comme en prod. */
const nextClientIp = () => {
  ipCounter++;
  return `203.${(ipCounter >>> 16) & 255}.${(ipCounter >>> 8) & 255}.${ipCounter & 255}`;
};

async function runScenario(
  server: Awaited<ReturnType<typeof startServer>>,
  name: string,
  count: number,
  concurrency: number,
  make: (i: number) => { path: string; headers?: Record<string, string>; expect: number },
): Promise<ScenarioResult> {
  const samples: Sample[] = [];
  let unexpected = 0;
  let next = 0;
  const logBefore = server.logLines();
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const i = next++;
      const spec = make(i);
      const sample = await request(server.port, server.agent, spec.path, { 'x-forwarded-for': nextClientIp(), ...spec.headers });
      if (sample.status !== spec.expect) unexpected++;
      samples.push(sample);
    }
  }));
  const elapsed = performance.now() - t0;
  // Laisse pino vider ses lignes sur stdout.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
  return {
    name,
    requests: count,
    reqPerSec: (count / elapsed) * 1000,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    bytesPerResponse: samples.reduce((sum, s) => sum + s.bytes, 0) / samples.length,
    encoding: String(samples[0]?.headers['content-encoding'] ?? 'identité'),
    unexpected,
    logLinesPerRequest: (server.logLines() - logBefore) / count,
    rssAfterMb: server.rssMb(),
  };
}

async function runHttp(root: string, quick: boolean) {
  const server = await startServer(root);
  const n = quick ? 400 : 3_000;
  const concurrency = 32;
  const br = { 'accept-encoding': 'gzip, deflate, br, zstd' };
  const results: ScenarioResult[] = [];
  try {
    const asset = `/assets/${server.largest.name}`;
    const etag = (await request(server.port, server.agent, asset, br)).headers.etag ?? '';
    const scenarios: Array<[string, number, (i: number) => { path: string; headers?: Record<string, string>; expect: number }]> = [
      ['/health', n, () => ({ path: '/health', expect: 200 })],
      ['index.html (CSP, br)', n, () => ({ path: '/', headers: br, expect: 200 })],
      [`plus gros chunk ${(server.largest.size / 1024).toFixed(0)} Kio (br)`, Math.ceil(n / 4), () => ({ path: asset, headers: br, expect: 200 })],
      ['chunk revalidé (304)', n, () => ({ path: asset, headers: { ...br, 'if-none-match': etag }, expect: 304 })],
      ['navigation SPA /project/…', n, (i) => ({ path: `/project/bench--${i}`, headers: br, expect: 200 })],
      ['chunk absent (404)', n, (i) => ({ path: `/assets/missing-${i}.js`, expect: 404 })],
      ['API /api/app-translations', Math.ceil(n / 4), () => ({ path: '/api/app-translations?locale=fr', headers: br, expect: 200 })],
      ['API inconnue (404)', n, () => ({ path: '/api/does-not-exist', expect: 404 })],
      ['/dem-tiles (204)', n, (i) => ({ path: `/dem-tiles/12/${2000 + (i % 100)}/1400.png`, expect: 204 })],
      ['chemins hostiles (400/404)', n, (i) => [
        { path: '/..%2f..%2fserver.mjs', expect: 400 },
        // `%2e%2e` est déjà résolu par le parseur d'URL (WHATWG) : reste dans dist/, asset absent.
        { path: '/assets/%2e%2e/%2e%2e/package.json', expect: 404 },
        { path: '/api/_lib/i18n', expect: 404 },
        { path: `${asset}.map`, expect: 404 },
        { path: `${asset}.br`, expect: 404 },
      ][i % 5]],
    ];
    for (const [name, count, make] of scenarios) {
      await runScenario(server, name, Math.min(50, count), concurrency, make); // chauffe
      results.push(await runScenario(server, name, count, concurrency, make));
    }
    // Quota API : 120 requêtes par minute et par IP, la 121ᵉ répond 429.
    const statuses: number[] = [];
    for (let i = 0; i < 125; i++) {
      statuses.push((await request(server.port, server.agent, '/api/does-not-exist', { 'x-forwarded-for': '198.18.0.99' })).status);
    }
    const quotaOk = statuses.slice(0, 120).every((s) => s === 404) && statuses.slice(120).every((s) => s === 429);
    return { results, quotaOk, rssMb: server.rssMb() };
  } finally {
    server.stop();
  }
}

function printHttpResults(results: ScenarioResult[]) {
  const pad = (value: string, width: number) => value.padStart(width);
  console.log('\n  Serveur bundlé (node dist-server/server.mjs), 32 requêtes en parallèle, keep-alive');
  console.log(`  ${'scénario'.padEnd(34)}${pad('req/s', 8)}${pad('p50 ms', 8)}${pad('p95 ms', 8)}${pad('p99 ms', 8)}${pad('Kio/rép', 9)}${pad('encodage', 10)}${pad('journal', 9)}${pad('écarts', 7)}${pad('RSS Mo', 8)}`);
  for (const r of results) {
    console.log(`  ${r.name.padEnd(34)}${pad(r.reqPerSec.toFixed(0), 8)}${pad(r.p50.toFixed(2), 8)}${pad(r.p95.toFixed(2), 8)}${pad(r.p99.toFixed(2), 8)}${pad((r.bytesPerResponse / 1024).toFixed(1), 9)}${pad(r.encoding, 10)}${pad(r.logLinesPerRequest.toFixed(2), 9)}${pad(String(r.unexpected), 7)}${pad(r.rssAfterMb?.toFixed(0) ?? '?', 8)}`);
  }
}

export async function runServerApiBenchmark(options: { quick?: boolean; http?: boolean; root?: string; json?: string } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Serveur de prod (server.mjs) & primitives de sécurité');
  const iterations = options.quick ? 5 : 20;
  const root = path.resolve(options.root ?? REPO);
  const { lruHitRate } = runPrimitives(await loadServerModules(root), suite, iterations);
  console.log(`  cache LRU tuiles : ${(lruHitRate * 100).toFixed(1)} % de lectures servies`);

  let load: Awaited<ReturnType<typeof runHttp>> | null = null;
  if (options.http !== false) {
    load = await runHttp(root, options.quick ?? false);
    printHttpResults(load.results);
    console.log(`  quota API 120/min puis 429 : ${load.quotaOk ? 'OK' : 'ÉCHEC'} · mémoire du serveur après charge : ${load.rssMb?.toFixed(0) ?? '?'} Mo`);
    const broken = load.results.filter((r) => r.unexpected > 0);
    for (const r of broken) suite.addRegressionRisk(`${r.name} : ${r.unexpected} réponse(s) au statut inattendu.`);
    if (!load.quotaOk) suite.addRegressionRisk('Quota API : la 121ᵉ requête de la minute ne répond pas 429.');
    const translations = load.results.find((r) => r.name.startsWith('API /api/app-translations'));
    if (translations && translations.encoding === 'identité') {
      suite.addRegressionRisk(`Réponses API non compressées (${(translations.bytesPerResponse / 1024).toFixed(0)} Kio pour /api/app-translations).`);
    }
  }
  if (options.json) {
    fs.writeFileSync(options.json, JSON.stringify({ primitives: suite.results, lruHitRate, http: load }, null, 1));
  }
  return suite;
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-server-api.ts')) {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  runServerApiBenchmark({
    quick: args.includes('--quick'),
    http: !args.includes('--no-http'),
    root: valueOf('--root'),
    json: valueOf('--json'),
  }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
    const failed = suite.results.some((r) => r.status === 'FAIL') || suite.regressionRisks.some((risk) => /inattendu|429/.test(risk));
    if (failed) process.exitCode = 1;
  }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
