/**
 * Banc du dashboard sur le build de production : serveur bundlé réel
 * (`node dist-server/server.mjs` : compression précalculée, en-têtes de cache,
 * CSP de production), navigateur Playwright (Edge par défaut : le vrai GPU en
 * headless sur Windows), faux Appwrite (fakeAppwrite.mjs), télémétrie coupée.
 *
 * `root` vise une copie (ex. HEAD extraite par `git archive`, avec son dist/
 * construit avec les `VITE_*` publics du .env) pour un avant/après.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createFakeAppwrite, transferDelayMs } from './fakeAppwrite.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Profils réseau (débits en kbit/s). « fibre » ≈ pas d'émulation utile ;
 * « 4g-lent » = profil « Slow 4G » de Lighthouse (150 ms, 1,6 Mbit/s).
 */
export const NETWORK_PROFILES = {
  fibre: { rttMs: 10, downKbps: 200_000, upKbps: 50_000 },
  adsl: { rttMs: 40, downKbps: 8_000, upKbps: 1_000 },
  '4g': { rttMs: 70, downKbps: 9_000, upKbps: 3_000 },
  '4g-lent': { rttMs: 150, downKbps: 1_600, upKbps: 750 },
  '3g': { rttMs: 300, downKbps: 700, upKbps: 400 },
};

export const BENCH_USER = { $id: 'benchuser01', email: 'bench@redview.test', name: 'Banc RedView' };

/** Variables `VITE_*` avec lesquelles `root/dist` a été construit (mêmes fichiers que Vite, mode production). */
function readBuildEnv(root) {
  const env = {};
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return {
    appwriteEndpoint: env.VITE_APPWRITE_ENDPOINT || 'https://appwrite.redview.tech/v1',
    hasMapboxToken: Boolean(env.VITE_MAPBOX_TOKEN),
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Lance le serveur bundlé de `root` (dist/ précompressé, dist-server/ à jour).
 * `port` fixe : un autre build sur la même origine = un déploiement vu par le
 * navigateur (même Service Worker, mêmes caches).
 */
export async function startAppServer(root, { port: fixedPort = null } = {}) {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error(`${root}/dist absent : lancer \`npm run build:vite\` d'abord`);
  const bundle = path.join(root, 'dist-server', 'server.mjs');
  if (!fs.existsSync(bundle)) {
    const built = spawnSync(process.execPath, ['scripts/build-server.mjs'], { cwd: root, stdio: 'inherit' });
    if (built.status !== 0) throw new Error('build-server a échoué');
  }
  if (!fs.readdirSync(path.join(root, 'dist', 'assets')).some((name) => name.endsWith('.br'))) {
    const packed = spawnSync(process.execPath, ['scripts/precompress-dist.mjs', 'dist'], { cwd: root, stdio: 'inherit' });
    if (packed.status !== 0) throw new Error('precompress-dist a échoué');
  }
  const port = fixedPort ?? await freePort();
  const child = spawn(process.execPath, ['dist-server/server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production', SENTRY_DSN_SERVER: '', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ok = await fetch(`${origin}/health`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server.mjs ne démarre pas\n${stderr}`);
    await sleep(200);
  }
  return {
    origin,
    port,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
    }),
  };
}

/**
 * Navigateur à profil vierge. `channel: 'msedge'` (défaut) a le GPU réel en
 * headless sous Windows ; `chromium` (CI) dessine WebGL en logiciel.
 *
 * @param {{ channel?: string, headless?: boolean, viewport?: { width: number, height: number }, proxy?: string | null }} [options]
 */
export async function launchBrowser({ channel = 'msedge', headless = true, viewport = { width: 1600, height: 900 }, proxy = null } = {}) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'rv-dashboard-perf-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: channel === 'chromium' ? undefined : channel,
    headless,
    viewport,
    deviceScaleFactor: 1,
    args: [
      '--enable-unsafe-swiftshader',
      '--enable-precise-memory-info',
      // throttleProxy.mjs : tout le trafic, serveur local compris (`<-loopback>` lève l'exemption implicite).
      ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>'] : []),
    ],
  });
  return {
    context,
    close: async () => {
      await context.close().catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Faux backend + télémétrie coupée sur un contexte : Appwrite en mémoire,
 * `/api/billing/*` (vérifie le JWT auprès d'Appwrite côté serveur), GlitchTip
 * (erreurs et rapports CSP, gardés pour les contrôles).
 *
 * Mesure d'audience : coupée par défaut. `analytics: true` force le tracker
 * first-party (drapeau `rv:analytics-test`), sert la copie figée du vrai
 * tracker Umami (umami-tracker-3.4.0.js) à la place de `/s/x.js` et garde
 * chaque envoi de `/s/api/send` dans `telemetry.analytics` (rien ne sort).
 *
 * @param {import('playwright').BrowserContext} context
 * @param {{ root: string, origin: string, loggedIn?: boolean, network?: { rttMs: number, downKbps: number } | null, analytics?: boolean }} options
 */
export async function installBackend(context, { root, origin, loggedIn = true, network = null, analytics = false }) {
  const { appwriteEndpoint } = readBuildEnv(root);
  const appwrite = createFakeAppwrite({ endpoint: appwriteEndpoint, user: BENCH_USER, loggedIn, network });
  await appwrite.install(context);
  /** @type {{ cspReports: string[], errors: string[], analytics: Array<{ type: string, payload: Record<string, unknown> }> }} */
  const telemetry = { cspReports: [], errors: [], analytics: [] };
  await context.route('https://errors.redview.tech/**', async (route) => {
    const body = route.request().postData() ?? '';
    if (/\/security\//.test(route.request().url())) {
      try {
        const report = JSON.parse(body)['csp-report'] ?? JSON.parse(body);
        telemetry.cspReports.push(`${report['effective-directive'] ?? report['violated-directive']} ← ${report['blocked-uri'] ?? '?'}`);
      } catch {
        telemetry.cspReports.push(body.slice(0, 200));
      }
    } else {
      // Enveloppe Sentry : une ligne d'en-tête, puis paires (en-tête d'item, item).
      for (const line of body.split('\n')) {
        try {
          const item = JSON.parse(line);
          const exception = item?.exception?.values?.[0];
          if (exception) telemetry.errors.push(`${exception.type}: ${String(exception.value).slice(0, 200)}`);
          else if (item?.message) telemetry.errors.push(String(item.message?.formatted ?? item.message).slice(0, 200));
        } catch {
          // Ligne non JSON (pièce jointe) : ignorée.
        }
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // Mesure d'audience de production : jamais alimentée par un banc.
  await context.route('https://analytics.redview.tech/**', (route) => route.fulfill({ status: 204, body: '' }));
  await installAnalytics(context, origin, telemetry, analytics);
  await context.route(`${origin}/api/billing/**`, async (route) => {
    const body = JSON.stringify({ subscription: null, plan: 'beta', customer: null, invoices: [], paymentMethods: [] });
    await sleep(transferDelayMs(network, body.length + 400));
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  return { appwrite, telemetry };
}

const UMAMI_TRACKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'umami-tracker-3.4.0.js');

/** Tracker first-party de l'app (`/s/`) : coupé, ou vrai tracker local avec envois capturés. */
async function installAnalytics(context, origin, telemetry, enabled) {
  if (!enabled) {
    await context.route(`${origin}/s/**`, (route) => route.fulfill({ status: 204, body: '' }));
    return;
  }
  await context.addInitScript(() => {
    try {
      localStorage.setItem('rv:analytics-test', '1');
    } catch {
      // Stockage indisponible : pas de mesure, le contrôle le dira.
    }
  });
  const tracker = fs.readFileSync(UMAMI_TRACKER, 'utf8');
  await context.route(`${origin}/s/x.js`, (route) => route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: tracker }));
  await context.route(`${origin}/s/api/send`, async (route) => {
    try {
      const { type, payload } = JSON.parse(route.request().postData() ?? '{}');
      telemetry.analytics.push({ type: String(type), payload: payload ?? {} });
    } catch {
      telemetry.analytics.push({ type: 'invalid', payload: {} });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/** Médiane et percentiles d'une série. */
export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] : NaN);
  return { n: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}
