/**
 * Robustesse de l'API face à des entrées hostiles.
 *
 *   npm run bench:api-fuzz      (après `npm run build` : le repli SPA sert dist/index.html)
 *
 * Reconstruit le serveur de prod bundlé (`build-server.mjs --app`), le lance
 * dans un processus enfant dont toute connexion hors de la boucle locale est
 * coupée (`block-egress.mjs` : Appwrite, Stripe, Météo-France, BRouter… se
 * comportent comme en panne réseau, rien ne sort de la machine), puis envoie à
 * chaque route de `api/` quelques milliers de requêtes : toutes les méthodes,
 * requête hostile (`__proto__`, tableaux, NaN, chemins `..`, chaînes géantes),
 * chaque paramètre lu par la route avec des valeurs limites, corps JSON
 * invalides ou détournés, champs du corps de mauvais type, jetons d'accès
 * faux ou énormes, plus des chemins statiques et de tuiles hostiles. Une IP
 * différente par requête (`X-Forwarded-For`) pour ne pas mesurer la limite de
 * débit.
 *
 * Échoue (code 1) sur une réponse 500, une requête sans réponse (20 s), une
 * connexion coupée sans raison, un serveur qui s'arrête, ou une erreur non
 * gérée dans ses journaux. Les 502 / 503 sont attendues (amonts coupés). Un
 * corps au-delà de la limite peut voir sa connexion coupée pendant l'envoi
 * (413 puis fermeture ; en production nginx lit le corps avant).
 * Rapport détaillé : script-test-bench/reports/api-fuzz/.
 *
 * Premier passage (2026-10-09, 21 routes) : aucune 500, aucun délai.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT_DIR = path.join(ROOT, 'script-test-bench/reports/api-fuzz');
const REQUEST_TIMEOUT_MS = 20_000;
const CONCURRENCY = 8;
const OVERSIZED_BODY_BYTES = 3 * 1024 * 1024;

function listRoutes(dir, prefix = '') {
  const routes = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routes.push(...listRoutes(full, `${prefix}${entry.name}/`));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      routes.push({ route: `${prefix}${entry.name.slice(0, -3)}`, source: fs.readFileSync(full, 'utf8') });
    }
  }
  return routes;
}

/** Noms de paramètres / champs lus par une route, tirés de sa source. */
function namesFrom(source, patterns) {
  const names = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      for (const name of match[1].split(',').map((part) => part.trim().split(/[\s:=]/)[0]).filter(Boolean)) {
        if (/^[A-Za-z_][\w-]*$/.test(name)) names.add(name);
      }
    }
  }
  return [...names];
}

const QUERY_PATTERNS = [
  /req\.query\.(\w+)/g,
  /req\.query\[['"]([\w:-]+)['"]\]/g,
  /readQueryParam\(req, ['"]([\w:-]+)['"]/g,
  /searchParams\.get\(['"]([\w:-]+)['"]\)/g,
  /query\.get\(['"]([\w:-]+)['"]\)/g,
];
const BODY_PATTERNS = [/body\.(\w+)/g, /const \{([^}]+)\} = bodyFields\(req\)/g, /\{([^}]+)\} = await readJsonBody/g];

const VALUES = [
  '', ' ', 'NaN', 'Infinity', '-1e309', '1e309', '0', '-1', '99999999999999999999999', 'null', 'true', '[]', '{}',
  '../../../etc/passwd', '..%2f..%2fetc', '%00', '\u0000', '<script>alert(1)</script>', 'a'.repeat(4000), 'é'.repeat(600),
  '1,2|3,4', '-91,181|200,-300', 'javascript:alert(1)', 'http://169.254.169.254/latest', '__proto__', '😀'.repeat(50),
];
const BODY_VALUES = [null, 0, -1, 1e308, true, [], {}, '', 'x'.repeat(6000), { $ne: 1 }, ['a', 'b'], 'not-an-email', '../..'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

/** Statut HTTP, ou -1 erreur de réponse, -2 connexion coupée, -3 délai dépassé. */
function send(port, { method, pathname, headers = {}, body }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: { 'X-Forwarded-For': nextIp(), ...headers, ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { if (chunks.length < 64) chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - started, body: Buffer.concat(chunks).toString('utf8').slice(0, 300) }));
      res.on('error', (error) => resolve({ status: -1, ms: Date.now() - started, body: String(error) }));
    });
    req.on('error', (error) => resolve({ status: -2, ms: Date.now() - started, body: String(error) }));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); resolve({ status: -3, ms: Date.now() - started, body: 'timeout' }); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function buildCases(routes) {
  const cases = [];
  const hostileQuery = '?' + [
    'q=%00', 'lat=NaN', 'lon=Infinity', 'url=javascript:alert(1)', '__proto__[x]=1', 'constructor[prototype][x]=1',
    'lonlats=1,2|3', 'profile=../../x', 'path=../../etc', 'host=evil', `p=${'a'.repeat(3000)}`, 'a=1&a=2',
  ].join('&');
  for (const { route, source } of routes) {
    const base = `/api/${route}`;
    const queryNames = namesFrom(source, QUERY_PATTERNS);
    const bodyNames = namesFrom(source, BODY_PATTERNS).filter((name) => !['length', 'toString'].includes(name));
    for (const method of METHODS) {
      cases.push({ route, method, pathname: base });
      cases.push({ route, method, pathname: base + hostileQuery });
      cases.push({ route, method, pathname: `${base}/..%2f..%2fetc%2fpasswd` });
      cases.push({ route, method, pathname: base, headers: { Authorization: 'Bearer x' } });
      cases.push({ route, method, pathname: base, headers: { Authorization: `Bearer ${'a'.repeat(7000)}` } });
    }
    for (const name of queryNames) {
      for (const value of VALUES) {
        cases.push({ route, method: 'GET', pathname: `${base}?${encodeURIComponent(name)}=${encodeURIComponent(value)}` });
      }
      cases.push({ route, method: 'GET', pathname: `${base}?${name}=1&${name}=2` });
      cases.push({ route, method: 'GET', pathname: `${base}?${name}[]=1&${name}[x]=2` });
    }
    const rawBodies = ['', '{', 'null', '[]', '"x"', '123', '{"__proto__":{"polluted":1}}', '{"constructor":{"prototype":{"polluted":1}}}'];
    for (const method of ['POST', 'PUT', 'DELETE']) {
      for (const body of rawBodies) {
        for (const contentType of ['application/json', 'text/plain']) {
          cases.push({ route, method, pathname: base, headers: { 'Content-Type': contentType, Authorization: 'Bearer x' }, body });
        }
      }
      cases.push({ route, method, pathname: base, headers: { 'Content-Type': 'application/json' }, body: 'a'.repeat(OVERSIZED_BODY_BYTES), oversized: true });
      for (const name of bodyNames) {
        for (const value of BODY_VALUES) {
          cases.push({ route, method, pathname: base, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: JSON.stringify({ [name]: value, action: value }) });
        }
      }
    }
    // Action connue et champs hostiles (auth/*, projects/share, billing/*).
    for (const action of namesFrom(source, [/case ['"]([\w-]+)['"]/g, /action === ['"]([\w-]+)['"]/g])) {
      for (const value of BODY_VALUES) {
        const fields = Object.fromEntries(bodyNames.map((name) => [name, value]));
        cases.push({ route, method: 'POST', pathname: base, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: JSON.stringify({ ...fields, action }) });
      }
    }
  }
  // Tuiles de repli et chemins hors API.
  for (const pathname of [
    '/radar-tiles/99/1/1?host=opera&path=/opera/20261009T1300', '/radar-tiles/5/999999/1?host=opera&path=/opera/x',
    '/radar-tiles/5/1/1?host=opera&path=../../etc', '/slope-tiles/-1/0/0', '/altitude-tiles/30/1/1', '/dem-tiles/1/1/1',
    '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fserver.mjs', '/project/%00', '/viewer?x=%00', '/.well-known/../server.mjs',
    `/api/${'a'.repeat(5000)}`, '/api/_lib/http', '/api/auth/..%2f_lib%2fhttp', '/index.html.map', '/assets/x.js.map',
  ]) {
    for (const method of ['GET', 'POST', 'HEAD']) cases.push({ route: 'static', method, pathname });
  }
  return cases;
}

function isFailure(result) {
  const { status } = result.res;
  if (status === 500 || status === -1 || status === -3) return true;
  if (status === -2) return !result.oversized;
  return false;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
    console.error('[api-fuzz] dist/ manquant : lancer `npm run build` d\'abord.');
    process.exit(2);
  }
  const build = spawnSync(process.execPath, ['scripts/build/build-server.mjs', '--app'], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) process.exit(2);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const routes = listRoutes(path.join(ROOT, 'api'));
  const cases = buildCases(routes);
  const port = await freePort();
  const logLines = [];
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(import.meta.dirname, 'block-egress.mjs')).href, path.join(ROOT, 'dist-server/server.mjs')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_ENV: 'production', PORT: String(port), LOG_LEVEL: 'warn',
      BROUTER_UPSTREAM: 'http://127.0.0.1:9', POI_UPSTREAM: 'http://127.0.0.1:9/poi', WEATHER_UPSTREAM: 'http://127.0.0.1:9/weather',
      OPENMETEO_UPSTREAM: 'http://127.0.0.1:9/openmeteo', APPWRITE_ENDPOINT: 'http://127.0.0.1:9/v1', APPWRITE_PROJECT_ID: 'fuzz',
      APPWRITE_API_KEY: 'fuzz', STRIPE_SECRET_KEY: 'sk_test_fuzz', STRIPE_WEBHOOK_SECRET: 'whsec_fuzz', METEOFRANCE_API_KEY: 'fuzz',
      MULTIPLAYER_INTERNAL_SECRET: 'fuzz', MULTIPLAYER_INTERNAL_URL: 'http://127.0.0.1:9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { for (const line of chunk.split('\n')) if (line.trim()) logLines.push(line); });
  }
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await send(port, { method: 'GET', pathname: '/health' });
    if (res.status === 200) break;
    if (Date.now() > deadline || exited) throw new Error(`le serveur ne démarre pas : ${JSON.stringify(exited)} ${logLines.slice(-5).join(' | ')}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log(`[api-fuzz] ${routes.length} routes, ${cases.length} requêtes`);
  const started = Date.now();
  const results = [];
  let index = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (index < cases.length && !exited) {
      const testCase = cases[index++];
      const res = await send(port, testCase);
      results.push({ ...testCase, body: testCase.body?.length > 200 ? `${testCase.body.slice(0, 200)}…(${testCase.body.length})` : testCase.body, res });
    }
  }));
  const health = exited ? { status: 'arrêté' } : await send(port, { method: 'GET', pathname: '/health' });
  child.kill();

  const byStatus = {};
  for (const result of results) byStatus[result.res.status] = (byStatus[result.res.status] ?? 0) + 1;
  const failures = results.filter(isFailure);
  const byRoute = {};
  for (const failure of failures) (byRoute[`${failure.route} ${failure.res.status}`] ??= []).push(failure);
  // Erreurs non gérées seulement : les avertissements « amont injoignable » sont attendus.
  const unhandled = logLines.filter((line) => /unhandled|uncaught|"level":60/i.test(line));
  fs.writeFileSync(path.join(OUT_DIR, 'failures.json'), JSON.stringify(byRoute, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'server.log'), logLines.join('\n'));
  console.log(`[api-fuzz] ${results.length} réponses en ${Math.round((Date.now() - started) / 1000)} s, statuts ${JSON.stringify(byStatus)}`);
  console.log(`[api-fuzz] serveur après coup : ${health.status} ; erreurs non gérées : ${unhandled.length} ; échecs : ${failures.length}`);
  for (const line of unhandled.slice(0, 10)) console.log('  journal :', line.slice(0, 300));
  for (const [key, list] of Object.entries(byRoute).slice(0, 30)) {
    const sample = list[0];
    console.log(`  ${key} × ${list.length} — ex. ${sample.method} ${sample.pathname.slice(0, 120)} ${sample.body ? `corps=${String(sample.body).slice(0, 80)}` : ''} → ${sample.res.body.slice(0, 160)}`);
  }
  const ok = failures.length === 0 && !exited && unhandled.length === 0 && health.status === 200;
  console.log(ok ? '[api-fuzz] OK' : `[api-fuzz] ÉCHEC (détail : ${path.relative(ROOT, OUT_DIR)})`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
