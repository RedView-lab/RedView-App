/**
 * Banc de charge du routage, hors production (`npm run bench:routing-load`) :
 * vrai pipeline client (resolveRouteRequest : profil, recherche fine, secours,
 * délai, tracé grossier, ancres), vrai proxy (`api/brouter.ts` : file devant
 * BRouter, caches) et faux BRouter qui reproduit les règles de RouteServer
 * (fakeBrouter.ts : 4 fils, attente de 2 s puis meurtre du plus ancien, aucun
 * client parti détecté, envoi de profil qui dort 1 s, calcul partagé sur
 * quelques cœurs).
 *
 * Chaque utilisateur virtuel a SES modules (une instance du pipeline par
 * utilisateur, comme un navigateur : file « chargée » vue, cache des tracés et
 * des profils), tracés tirés comme vps-load (60 % < 100 km, 30 % 100–200, 8 %
 * 200–500, 2 % > 500, départ ou arrivée décalés à chaque geste). Un geste sur
 * `--supersede` est remplacé avant sa fin (le point déplacé à nouveau : le
 * premier calcul est abandonné). Après la phase réaliste, `--bursts` rafales
 * (tous les utilisateurs tracent au même instant).
 *
 * `--roots a,b` : deux versions (client + proxy) en vagues entrelacées, ordre
 * alterné, un faux BRouter et un proxy neufs par vague.
 *
 *   npx tsx script-test-bench/routing-load/run.ts [--roots a,b] [--waves 2] [--vus 40] [--seconds 120]
 *     [--think 25] [--supersede 0.15] [--bursts 2] [--cores 3] [--threads 4] [--maxrun 60] [--label nom]
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, type ViteDevServer } from 'vite';

import { buildItinerary, type LoadedApp } from '../routing-quality/app.ts';
import { CONFIGS, ROUTES } from '../routing-quality/scenarios.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}
const ROOTS = arg('roots', repo).split(',').map((root) => path.resolve(root));
const WAVES = Number(arg('waves', '2'));
const VUS = Number(arg('vus', '40'));
const SECONDS = Number(arg('seconds', '120'));
const THINK_S = Number(arg('think', '25'));
const SUPERSEDE = Number(arg('supersede', '0.15'));
const BURSTS = Number(arg('bursts', '2'));
const CORES = arg('cores', '3');
const THREADS = arg('threads', '4');
/** `-DmaxRunningTime` de BRouter en production (server/vps/brouter.service). */
const MAX_RUNNING_S = arg('maxrun', '60');
const LABEL = arg('label', `routing-load-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = Math.PI / 180;
  const s = Math.sin(((b.lat - a.lat) * toRad) / 2) ** 2
    + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(((b.lon - a.lon) * toRad) / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function jitter(point: { lat: number; lon: number }, meters: number) {
  const angle = between(0, Math.PI * 2);
  const distance = between(meters * 0.3, meters);
  return {
    lat: point.lat + (distance * Math.cos(angle)) / 111_320,
    lon: point.lon + (distance * Math.sin(angle)) / (111_320 * Math.cos((point.lat * Math.PI) / 180)),
  };
}

function waitFor<T>(child: ChildProcess, type: string): Promise<T> {
  return new Promise((resolve) => {
    const listener = (message: { type: string } & T) => {
      if (message.type !== type) return;
      child.off('message', listener);
      resolve(message);
    };
    child.on('message', listener);
  });
}

// ── Mesures ────────────────────────────────────────────────────────────────
type Series = Record<string, number[]>;
const results = new Map<string, Series>();
let currentRoot = '';
function record(name: string, value: number): void {
  let series = results.get(currentRoot);
  if (!series) {
    series = {};
    results.set(currentRoot, series);
  }
  (series[name] ??= []).push(value);
}

/** Requêtes vers le proxy faites pour le geste courant d'un utilisateur. */
const gestureContext = new AsyncLocalStorage<{ calls: number; routes: number }>();
let proxyPort = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('/api/brouter')) url = `http://127.0.0.1:${proxyPort}${url}`;
  const context = gestureContext.getStore();
  if (context) {
    context.calls += 1;
    if ((init?.method ?? 'GET') === 'GET') context.routes += 1;
  }
  const res = await realFetch(url, init);
  const waited = Number(res.headers.get('x-upstream-wait-ms'));
  if (Number.isFinite(waited) && res.headers.has('x-upstream-wait-ms')) record('attente-file', waited);
  if (res.status === 503) record('réponses-503', 1);
  if (res.status === 504) record('réponses-504', 1);
  return res;
}) as typeof fetch;

// ── Pipeline client, une instance par utilisateur ─────────────────────────
const viteServers = new Map<string, ViteDevServer>();

async function loaderFor(root: string): Promise<ViteDevServer> {
  let server = viteServers.get(root);
  if (!server) {
    server = await createServer({
      configFile: false,
      root,
      logLevel: 'error',
      appType: 'custom',
      resolve: { alias: { '@': path.join(root, 'src') } },
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      ssr: { noExternal: [] },
    });
    viteServers.set(root, server);
  }
  return server;
}

/** Modules neufs (état propre à cet utilisateur : caches, file chargée vue…). */
async function freshPipeline(root: string): Promise<{ app: LoadedApp; resolveRouteRequest: (args: any) => Promise<any> }> {
  const server = await loaderFor(root);
  server.moduleGraph.invalidateAll();
  const load = (rel: string) => server.ssrLoadModule(path.join(root, rel)) as Promise<any>;
  const defaults = await load('src/features/itineraryPanel/lib/project/defaultState.ts');
  const sync = await load('src/features/itineraryPanel/lib/project/syncTracageParams.ts');
  const resolveReq = await load('src/features/itineraryPanel/hooks/useItineraryBrouterRouting/resolveRouteRequest.ts');
  const app = {
    createDefaultItinerary: defaults.createDefaultItinerary,
    syncTracageOnActivityChange: sync.syncTracageOnActivityChange,
    syncTracageOnSurfaceRangeChange: sync.syncTracageOnSurfaceRangeChange,
  } as unknown as LoadedApp;
  return { app, resolveRouteRequest: resolveReq.resolveRouteRequest };
}

const BANDS: Array<[string, number, (km: number) => boolean]> = [
  ['<100', 60, (km) => km < 100],
  ['100-200', 30, (km) => km >= 100 && km < 200],
  ['200-500', 8, (km) => km >= 200 && km < 500],
  ['>500', 2, (km) => km >= 500],
];
const SIMPLE_ROUTES = ROUTES.filter((route) => !route.via);

function pickRoute() {
  let roll = Math.random() * 100;
  let band = BANDS[0];
  for (const candidate of BANDS) {
    roll -= candidate[1];
    if (roll <= 0) {
      band = candidate;
      break;
    }
  }
  const inBand = SIMPLE_ROUTES.filter((route) => band[2](haversineKm(route.start, route.end)));
  const route = (inBand.length > 0 ? inBand : SIMPLE_ROUTES)[Math.floor(Math.random() * (inBand.length || SIMPLE_ROUTES.length))];
  return { start: route.start, end: route.end, band: band[0] };
}

class VirtualUser {
  private readonly pipeline: Awaited<ReturnType<typeof freshPipeline>>;
  private readonly itinerary: any;
  private route: ReturnType<typeof pickRoute>;
  private current: AbortController | null = null;

  constructor(pipeline: Awaited<ReturnType<typeof freshPipeline>>, index: number) {
    this.pipeline = pipeline;
    this.itinerary = buildItinerary(pipeline.app, CONFIGS[index % CONFIGS.length]);
    this.route = pickRoute();
  }

  /** Un geste (point déplacé) ; remplacé avant sa fin avec la probabilité `--supersede`. */
  async gesture(): Promise<void> {
    if (Math.random() < 0.5) this.route = { ...this.route, end: jitter(this.route.end, 1_500) };
    else this.route = { ...this.route, start: jitter(this.route.start, 1_500) };
    const superseded = Math.random() < SUPERSEDE;
    const controller = new AbortController();
    this.current = controller;
    const context = { calls: 0, routes: 0 };
    const t0 = performance.now();
    const work = gestureContext.run(context, () => this.pipeline.resolveRouteRequest({
      itinerary: this.itinerary,
      signal: controller.signal,
      requestBase: { start: this.route.start, end: this.route.end, via: [], signal: controller.signal },
      setRouteWarnings: () => {},
    }));
    if (superseded) {
      const timer = setTimeout(() => controller.abort(), between(500, 4_000));
      try {
        await work;
        clearTimeout(timer);
      } catch {
        clearTimeout(timer);
      }
      if (controller.signal.aborted) {
        record('gestes-remplacés', 1);
        await this.gesture();
        return;
      }
    }
    try {
      await work;
      const ms = performance.now() - t0;
      record('geste', ms);
      record(`geste.${this.route.band}`, ms);
      record('requêtes-par-geste', context.calls);
      record('tracés-par-geste', context.routes);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      record(`échec:${message.replace(/\d+/g, 'N').slice(0, 60)}`, 1);
      record('échecs', 1);
    }
  }

  async run(until: number, bursts: number[]): Promise<void> {
    const pending = [...bursts];
    while (Date.now() < until) {
      const nextBurst = pending[0] ?? Number.POSITIVE_INFINITY;
      const think = -Math.log(1 - Math.random()) * THINK_S * 1000;
      if (Date.now() + think >= nextBurst) {
        await sleep(Math.max(0, nextBurst - Date.now()));
        pending.shift();
      } else {
        await sleep(think);
      }
      if (Date.now() >= until) break;
      await this.gesture();
    }
  }
}

// ── Déroulé ────────────────────────────────────────────────────────────────
const fakeStats = new Map<string, Array<Record<string, number>>>();

async function runWave(root: string): Promise<void> {
  currentRoot = root;
  const brouter = fork(path.join(here, 'fakeBrouter.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, FAKE_BROUTER_CORES: CORES, FAKE_BROUTER_THREADS: THREADS, FAKE_BROUTER_MAX_RUNNING_S: MAX_RUNNING_S },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const { port: brouterPort } = await waitFor<{ port: number }>(brouter, 'ready');
  const proxy = fork(path.join(here, 'proxy.ts'), [], {
    cwd: root,
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, ROUTING_LOAD_ROOT: root, BROUTER_UPSTREAM: `http://127.0.0.1:${brouterPort}` },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  ({ port: proxyPort } = await waitFor<{ port: number }>(proxy, 'ready'));

  const users: VirtualUser[] = [];
  for (let index = 0; index < VUS; index += 1) users.push(new VirtualUser(await freshPipeline(root), index));
  const start = Date.now() + 1_000;
  const until = start + SECONDS * 1000;
  const bursts = Array.from({ length: BURSTS }, (_, burst) => until + 2_000 + burst * 20_000);
  await Promise.all(users.map(async (user, index) => {
    // Arrivées étalées sur les 20 premières secondes.
    await sleep(Math.max(0, start - Date.now()) + (index / VUS) * 20_000);
    await user.run(bursts.length > 0 ? bursts[bursts.length - 1] + 1 : until, bursts);
  }));
  // Les derniers calculs (abandonnés compris) finissent avant le relevé du faux BRouter.
  await sleep(3_000);
  const statsReply = waitFor<{ stats: Record<string, number> }>(brouter, 'stats');
  brouter.send({ type: 'stats' });
  const { stats } = await statsReply;
  (fakeStats.get(root) ?? fakeStats.set(root, []).get(root)!).push(stats);
  proxy.disconnect();
  brouter.disconnect();
  proxy.kill();
  brouter.kill();
}

const short = (root: string) => (ROOTS.length > 1 ? `${ROOTS.indexOf(root) === 0 ? 'A' : 'B'} ${path.basename(root)}` : path.basename(root));
console.log(`Banc de charge du routage — ${VUS} utilisateurs, ${SECONDS} s + ${BURSTS} rafale(s), un geste toutes les ~${THINK_S} s, ${Math.round(SUPERSEDE * 100)} % remplacés ; faux BRouter : ${THREADS} fils, ${CORES} cœurs`);
for (let wave = 0; wave < WAVES; wave += 1) {
  for (const root of wave % 2 === 0 ? ROOTS : [...ROOTS].reverse()) {
    const t0 = Date.now();
    await runWave(root);
    const series = results.get(root) ?? {};
    console.log(`  vague ${wave + 1} · ${short(root)} : geste p50 ${Math.round(percentile(series.geste ?? [], 0.5))} ms, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}

// ── Rapport ────────────────────────────────────────────────────────────────
const cell = (series: Series, name: string) => {
  const values = series[name] ?? [];
  if (values.length === 0) return '—';
  return `${Math.round(percentile(values, 0.5))} / ${Math.round(percentile(values, 0.95))} (${values.length})`;
};
const count = (series: Series, name: string) => String((series[name] ?? []).length);
const mean = (series: Series, name: string) => {
  const values = series[name] ?? [];
  return values.length === 0 ? '—' : (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
};
const sumStats = (root: string, key: string) => (fakeStats.get(root) ?? []).reduce((total, stats) => total + (stats[key] ?? 0), 0);
const rows: Array<[string, (root: string) => string]> = [
  ['Geste (tracé) p50 / p95 ms (n)', (root) => cell(results.get(root) ?? {}, 'geste')],
  ...BANDS.map(([band]): [string, (root: string) => string] => [`  ${band} km`, (root) => cell(results.get(root) ?? {}, `geste.${band}`)]),
  ['Échecs', (root) => count(results.get(root) ?? {}, 'échecs')],
  ['Gestes remplacés', (root) => count(results.get(root) ?? {}, 'gestes-remplacés')],
  ['Requêtes au proxy par geste (moyenne)', (root) => mean(results.get(root) ?? {}, 'requêtes-par-geste')],
  ['Tracés demandés par geste (moyenne)', (root) => mean(results.get(root) ?? {}, 'tracés-par-geste')],
  ['Attente dans la file du proxy p50 / p95 ms', (root) => cell(results.get(root) ?? {}, 'attente-file')],
  ['Réponses 503 / 504', (root) => `${count(results.get(root) ?? {}, 'réponses-503')} / ${count(results.get(root) ?? {}, 'réponses-504')}`],
  ['BRouter : calculs lancés', (root) => String(sumStats(root, 'routes'))],
  ['BRouter : livrés / pour personne / tués / expirés', (root) => ['delivered', 'abandoned', 'killed', 'timedOut'].map((key) => sumStats(root, key)).join(' / ')],
  ['BRouter : envois de profil', (root) => String(sumStats(root, 'uploads'))],
  ['BRouter : attentes de la boucle d’acceptation (n, s)', (root) => `${sumStats(root, 'contentionWaits')}, ${(sumStats(root, 'contentionWaitMs') / 1000).toFixed(1)}`],
  ['BRouter : CPU total / pour personne (s)', (root) => `${sumStats(root, 'cpuSeconds').toFixed(0)} / ${sumStats(root, 'wastedCpuSeconds').toFixed(0)}`],
  ['BRouter : fils vivants au plus', (root) => String(Math.max(...(fakeStats.get(root) ?? []).map((stats) => stats.maxLive ?? 0)))],
];
const failureKinds = new Set(ROOTS.flatMap((root) => Object.keys(results.get(root) ?? {}).filter((key) => key.startsWith('échec:'))));
for (const kind of failureKinds) rows.push([`  ${kind.slice(6)}`, (root) => count(results.get(root) ?? {}, kind)]);
const report = [
  `# Banc de charge du routage — ${LABEL}`,
  '',
  `${new Date().toISOString()} · ${VUS} utilisateurs · ${SECONDS} s + ${BURSTS} rafale(s) · un geste toutes les ~${THINK_S} s · ${Math.round(SUPERSEDE * 100)} % remplacés · faux BRouter ${THREADS} fils / ${CORES} cœurs · ${WAVES} vague(s) par version, entrelacées`,
  '',
  `| Mesure | ${ROOTS.map(short).join(' | ')} |`,
  `|---|${ROOTS.map(() => '---').join('|')}|`,
  ...rows.map(([label, value]) => `| ${label} | ${ROOTS.map(value).join(' | ')} |`),
].join('\n');
console.log(`\n${report}`);
const outDir = path.join(repo, 'script-test-bench/reports/routing-load');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `${LABEL}.md`), `${report}\n`);
writeFileSync(path.join(outDir, `${LABEL}.json`), JSON.stringify({ roots: ROOTS, results: Object.fromEntries(results), fakeStats: Object.fromEntries(fakeStats) }, null, 1));
for (const server of viteServers.values()) await server.close();
setTimeout(() => process.exit(0), 1_000).unref();
