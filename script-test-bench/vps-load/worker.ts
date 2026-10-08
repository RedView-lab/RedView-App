/**
 * Processus de travail du banc de charge du VPS (enfant de run.ts) : héberge
 * une tranche des utilisateurs virtuels, avec le vrai pipeline de routage de
 * l'app chargé une fois (SSR de Vite, comme bench:routing). Une salle de
 * co-édition entière vit dans un même processus : l'envoi et la réception
 * d'un lot se mesurent sur la même horloge.
 *
 * IPC : `init` → `ready` ; `phase` → `health` (toutes les 5 s) → `phase-done`
 * (mesures) ; `abort` ; `close-collab` → `collab-closed` ; `shutdown`.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { closeLoader, loadSrc } from '../audit/b-loader.ts';
import { buildItinerary, loadApp } from '../routing-quality/app.ts';
import { CONFIGS, ROUTES } from '../routing-quality/scenarios.ts';
import type { LoadTestSession } from './accounts.ts';
import { loadFixturePayloads, type OwnProject, type Room } from './fixtures.ts';
import { createBudget, createRandom, haversineM, sleep, type Sample } from './lib.ts';
import { VirtualUser, vuNet, wsTraffic, type RoutingKit, type VuShared } from './vu.ts';

export interface WorkerInit {
  type: 'init';
  appUrl: string;
  appwriteEndpoint: string;
  appwriteProject: string;
  coldAssets: string[];
  coldShare: number;
  apiPerMinute: number;
  /** `compacte` : charges des projets sans la copie `originalPoints` (A/B de la piste de compaction). */
  payloadVariant: 'actuelle' | 'compacte';
  vus: Array<{ session: LoadTestSession; own: OwnProject[]; room: Room | null; configIndex: number }>;
}

export interface WorkerPhase {
  type: 'phase';
  phase: 'realiste' | 'rafale';
  /** Index des comptes actifs dans ce processus. */
  active: number[];
  startAt: number;
  endAt: number;
  rampMs: number;
  waves: number[];
  seed: number;
}

/** Un relevé du pointeur en direct sur 5 (20 Hz × pairs : le reste n'apporte rien au p95). */
const POINTER_KEEP = 0.2;

let shared: VuShared;
const users = new Map<number, VirtualUser>();
let samples: Sample[] = [];
let healthOk = 0;
let healthErr = 0;
let aborted = false;

function record(sample: Sample): void {
  if (sample.name === 'collab.pointeur' && Math.random() > POINTER_KEEP) return;
  samples.push(sample);
  if (sample.ok) healthOk += 1;
  else if (sample.why !== 'budget-ip') healthErr += 1;
}

async function loadRouting(): Promise<RoutingKit> {
  const app = await loadApp();
  const profileCache = await loadSrc<{ clearProfileCache(): void }>('src/features/itineraryPanel/lib/brouter/profiles/profile-cache.ts');
  return {
    buildItinerary: (config) => buildItinerary(app, config),
    resolveRouteRequest: (args) => app.resolveRouteRequest(args),
    clearProfileCache: () => profileCache.clearProfileCache(),
    // Les configurations de vélo d'abord (les plus courantes), puis course et trail.
    configs: [...CONFIGS],
    routes: ROUTES.filter((route) => !route.via).map((route) => ({
      id: route.id,
      start: route.start,
      end: route.end,
      beelineKm: haversineM(route.start, route.end) / 1000,
    })),
  };
}

/**
 * `fetch` de l'app : les URL relatives (`/api/brouter…` du pipeline de
 * routage) partent vers la production, comptées pour l'utilisateur virtuel
 * courant (AsyncLocalStorage, suivi à travers les minuteurs du doublage).
 */
/** Octets échangés par ce processus (corps HTTP envoyés, Content-Length reçus ; trames temps réel dans vu.ts). */
const traffic = { up: 0, down: 0 };

function bodyBytes(body: BodyInit | null | undefined): number {
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}

/** Groupe d'une route Appwrite pour son temps serveur (`X-Debug-Speed`). */
function appwriteGroup(method: string, url: string): string {
  const path = new URL(url).pathname
    .replace(/^\/v1\/databases\/[^/]+\/collections\/([^/]+)\/documents(\/[^/]+)?$/, (_m, collection: string, id?: string) => `/db/${collection}${id ? '/:id' : ''}`)
    .replace(/\/files\/[^/]+/, '/files/:id');
  return `aw.serveur.${method.toUpperCase()} ${path}`;
}

/**
 * `fetch` du processus : les URL relatives (`/api/brouter…` du pipeline de
 * routage) partent vers la production, comptées pour l'utilisateur virtuel
 * courant (AsyncLocalStorage, suivi à travers les minuteurs du doublage) ;
 * chaque réponse d'Appwrite donne son temps de traitement côté serveur
 * (`X-Debug-Speed`), ce qui sépare le VPS du réseau du générateur.
 */
function installFetch(appUrl: string, appwriteEndpoint: string): void {
  const realFetch = globalThis.fetch;
  const appwriteOrigin = new URL(appwriteEndpoint).origin;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    traffic.up += bodyBytes(init?.body);
    if (!url.startsWith('/')) {
      const response = await realFetch(input, init);
      traffic.down += Number(response.headers.get('content-length')) || 0;
      if (url.startsWith(appwriteOrigin)) {
        const speed = Number(response.headers.get('x-debug-speed'));
        if (Number.isFinite(speed) && speed > 0) {
          record({ name: appwriteGroup(init?.method ?? 'GET', url), ms: Math.round(speed * 1000), ok: response.ok, at: Date.now() });
        }
      }
      return response;
    }
    const net = vuNet.getStore();
    if (net) net.calls += 1;
    const response = await realFetch(`${appUrl}${url}`, init);
    traffic.down += Number(response.headers.get('content-length')) || 0;
    net?.statuses.push(response.status);
    return response;
  }) as typeof fetch;
}

async function runRealistic(phase: WorkerPhase): Promise<void> {
  const random = createRandom(phase.seed);
  await Promise.all(phase.active.map(async (index) => {
    const user = users.get(index)!;
    user.stopped = false;
    await sleep(phase.startAt - Date.now() + random.next() * phase.rampMs);
    while (Date.now() < phase.endAt && !aborted) {
      await user.visit(phase.endAt);
      if (Date.now() < phase.endAt && !aborted) await sleep(2_000 + Math.random() * 8_000);
    }
  }));
}

async function runBurst(phase: WorkerPhase): Promise<void> {
  // Les co-éditeurs sans connexion ouverte la rouvrent d'abord (hors mesure de la rafale).
  await Promise.all(phase.active.map(async (index) => {
    const user = users.get(index)!;
    user.stopped = false;
    await user.prepareBurst();
  }));
  for (const waveAt of phase.waves) {
    if (aborted) break;
    await sleep(waveAt - Date.now());
    await Promise.all(phase.active.map((index) => users.get(index)!.burst()));
  }
}

process.on('message', (raw: unknown) => {
  const message = raw as { type: string };
  void (async () => {
    if (message.type === 'init') {
      const init = message as unknown as WorkerInit;
      installFetch(init.appUrl, init.appwriteEndpoint);
      const routing = await loadRouting();
      const payloads = loadFixturePayloads(init.payloadVariant);
      shared = {
        appUrl: init.appUrl,
        appwriteEndpoint: init.appwriteEndpoint,
        appwriteProject: init.appwriteProject,
        payloads,
        coldAssets: init.coldAssets,
        coldShare: init.coldShare,
        routing,
        apiBudget: createBudget(init.apiPerMinute),
        record,
        sentAt: new Map(),
      };
      for (const [localIndex, vu] of init.vus.entries()) {
        users.set(vu.session.index, new VirtualUser(shared, {
          session: vu.session,
          own: vu.own,
          room: vu.room,
          random: createRandom(0x5eed + vu.session.index * 7919),
          configIndex: vu.configIndex ?? localIndex,
        }));
      }
      process.send!({ type: 'ready', vus: users.size, configs: routing.configs.length });
    } else if (message.type === 'phase') {
      const phase = message as unknown as WorkerPhase;
      aborted = false;
      samples = [];
      shared.routing.clearProfileCache();
      // Santé du générateur : une boucle d'événements en retard ou un lien saturé fausse les latences.
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      const cpuStart = process.cpuUsage();
      const wallStart = performance.now();
      const trafficStart = { up: traffic.up + wsTraffic.up, down: traffic.down + wsTraffic.down };
      const health = setInterval(() => {
        process.send!({ type: 'health', ok: healthOk, err: healthErr, apiUsed: shared.apiBudget.used() });
        healthOk = 0;
        healthErr = 0;
      }, 5_000);
      try {
        if (phase.phase === 'realiste') await runRealistic(phase);
        else await runBurst(phase);
      } catch (error) {
        record({ name: 'banc.erreur', ms: 0, ok: false, at: Date.now(), why: String((error as Error)?.message ?? error).slice(0, 80) });
      } finally {
        clearInterval(health);
      }
      // Les lots / pointeurs encore en vol arrivent.
      await sleep(1_500);
      loop.disable();
      const cpu = process.cpuUsage(cpuStart);
      const seconds = (performance.now() - wallStart) / 1000;
      const generator = {
        loopP99Ms: loop.percentile(99) / 1e6,
        loopMaxMs: loop.max / 1e6,
        cpuCores: (cpu.user + cpu.system) / 1e6 / seconds,
        upMbps: ((traffic.up + wsTraffic.up - trafficStart.up) * 8) / 1e6 / seconds,
        downMbps: ((traffic.down + wsTraffic.down - trafficStart.down) * 8) / 1e6 / seconds,
      };
      process.send!({ type: 'phase-done', samples, generator });
      samples = [];
    } else if (message.type === 'abort') {
      aborted = true;
      for (const user of users.values()) {
        user.stopped = true;
        user.closeCollab();
      }
    } else if (message.type === 'close-collab') {
      for (const user of users.values()) user.closeCollab();
      await sleep(500);
      process.send!({ type: 'collab-closed' });
    } else if (message.type === 'shutdown') {
      for (const user of users.values()) user.closeCollab();
      await closeLoader();
      process.exit(0);
    }
  })().catch((error: unknown) => {
    process.send!({ type: 'fatal', error: String((error as Error)?.stack ?? error).slice(0, 2000) });
  });
});

process.on('disconnect', () => process.exit(0));
