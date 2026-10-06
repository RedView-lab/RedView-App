/**
 * Serveurs de prod bundlés : ce que les images lancent, démarré pour de vrai.
 *
 *   npm run server:check     (étape de check:full, après `vite build`)
 *
 * 1. `scripts/build-server.mjs` (dist-server/) et `scripts/precompress-dist.mjs` (dist/) ;
 * 2. `node dist-server/server.mjs` sur un port libre : /health, le plus gros
 *    chunk servi depuis sa variante brotli (octets identiques après
 *    décompression), une route API sans dépendance externe (brute et brotli),
 *    une route inconnue ;
 * 3. `node dist-server/multiplayer.mjs` (stockage fichier, dossier temporaire) :
 *    /health répond `{"ok":true}`.
 * Échoue (code ≠ 0) au premier écart : un bundle cassé ne doit pas atteindre Coolify.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DIST = path.join(ROOT, 'dist');
const STARTUP_TIMEOUT_MS = 20_000;

const log = (message) => console.log(`[server-check] ${message}`);
const children = [];

function stopChildren() {
  for (const child of children.splice(0)) {
    child.stopping = true;
    child.kill();
  }
}

function fail(message) {
  console.error(`[server-check] ÉCHEC : ${message}`);
  stopChildren();
  process.exit(1);
}

function runScript(script, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) fail(`${script} a échoué (code ${result.status})`);
}

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

/** GET brut (sans décompression automatique, contrairement à fetch). */
function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`délai dépassé : ${pathname}`)));
  });
}

async function waitForHealth(port, label) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await get(port, '/health');
      if (res.status === 200) return JSON.parse(res.body.toString('utf8'));
    } catch {
      // Pas encore à l'écoute.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return fail(`${label} : /health ne répond pas après ${STARTUP_TIMEOUT_MS / 1000} s`);
}

function start(label, entry, env) {
  const child = spawn(process.execPath, [entry], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code) => {
    if (!child.stopping) fail(`${label} s'est arrêté (code ${code})\n${stderr.slice(-2000)}`);
  });
  children.push(child);
  return child;
}

function largestAsset() {
  const assets = path.join(DIST, 'assets');
  if (!fs.existsSync(assets)) fail('dist/assets absent : lancer `vite build` d\'abord');
  const [largest] = fs.readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, size: fs.statSync(path.join(assets, name)).size }))
    .sort((a, b) => b.size - a.size);
  if (!largest) fail('aucun chunk JS dans dist/assets');
  return largest.name;
}

async function checkAppServer() {
  const port = await freePort();
  start('server.mjs', 'dist-server/server.mjs', { PORT: String(port), NODE_ENV: 'production', SENTRY_DSN_SERVER: '' });
  const health = await waitForHealth(port, 'server.mjs');
  if (health.status !== 'ok') fail(`server.mjs : /health inattendu ${JSON.stringify(health)}`);

  const asset = largestAsset();
  const original = fs.readFileSync(path.join(DIST, 'assets', asset));
  const br = await get(port, `/assets/${asset}`, { 'Accept-Encoding': 'br, gzip' });
  if (br.status !== 200 || br.headers['content-encoding'] !== 'br') {
    fail(`/assets/${asset} : attendu 200 + brotli, reçu ${br.status} ${br.headers['content-encoding'] ?? 'identité'}`);
  }
  if (!zlib.brotliDecompressSync(br.body).equals(original)) fail(`/assets/${asset} : variante brotli différente du fichier`);
  if (!fs.existsSync(path.join(DIST, 'assets', `${asset}.br`))) fail(`/assets/${asset} : servi sans variante précompressée`);
  const direct = await get(port, `/assets/${asset}.br`);
  if (direct.status !== 404) fail(`/assets/${asset}.br : attendu 404, reçu ${direct.status}`);
  log(`server.mjs : ${asset} ${(original.length / 1024).toFixed(0)} Ko → brotli ${(br.body.length / 1024).toFixed(0)} Ko`);

  const api = await get(port, '/api/app-translations?lang=en');
  if (api.status !== 200 || !String(api.headers['content-type']).includes('json')) {
    fail(`/api/app-translations : attendu 200 JSON, reçu ${api.status} ${api.headers['content-type']}`);
  }
  // Réponses API compressées par le serveur (server/api-compression.mjs) : mêmes octets une fois décompressés.
  const apiBr = await get(port, '/api/app-translations?lang=en', { 'Accept-Encoding': 'br, gzip' });
  if (apiBr.status !== 200 || apiBr.headers['content-encoding'] !== 'br' || !String(apiBr.headers.vary).includes('Accept-Encoding')) {
    fail(`/api/app-translations : attendu 200 + brotli + Vary, reçu ${apiBr.status} ${apiBr.headers['content-encoding'] ?? 'identité'} (Vary ${apiBr.headers.vary})`);
  }
  if (!zlib.brotliDecompressSync(apiBr.body).equals(api.body)) fail('/api/app-translations : corps brotli différent du corps brut');
  log(`server.mjs : /api/app-translations ${(api.body.length / 1024).toFixed(0)} Ko → brotli ${(apiBr.body.length / 1024).toFixed(0)} Ko`);
  const unknown = await get(port, '/api/does-not-exist');
  if (unknown.status !== 404) fail(`/api/does-not-exist : attendu 404, reçu ${unknown.status}`);
  log('server.mjs : /health, statiques précompressés et routes API OK');
}

async function checkMultiplayerServer() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redview-mp-check-'));
  try {
    start('multiplayer.mjs', 'dist-server/multiplayer.mjs', {
      MULTIPLAYER_PORT: String(port),
      MULTIPLAYER_METRICS_PORT: '',
      MULTIPLAYER_STORAGE: 'file',
      MULTIPLAYER_DATA_DIR: dataDir,
      NODE_ENV: 'development',
      SENTRY_DSN_SERVER: '',
    });
    const health = await waitForHealth(port, 'multiplayer.mjs');
    if (health.ok !== true) fail(`multiplayer.mjs : /health inattendu ${JSON.stringify(health)}`);
    log('multiplayer.mjs : /health OK');
  } finally {
    stopChildren();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

runScript('scripts/build-server.mjs');
runScript('scripts/precompress-dist.mjs', 'dist');
await checkAppServer();
stopChildren();
await checkMultiplayerServer();
log('OK');
