/**
 * RedView Test-Bench : dashboard sur le build de production.
 *
 * Serveur bundlé réel + faux Appwrite + navigateur (harness.mjs). Scénarios :
 *   load  chargement à froid puis à chaud par profil réseau (throttleProxy.mjs :
 *         tout le trafic, Service Worker compris) — écran de connexion (FCP,
 *         LCP), liste des projets, ouverture d'un projet jusqu'à la carte prête
 *         (style et tuiles chargés, tracé présent), octets par hôte, blocage du
 *         fil principal (long animation frames).
 *   map   fluidité de la carte sur un ultra de 1 200 km : déplacement, zoom à
 *         la molette, rotation/inclinaison — intervalles rAF, images > 33 ms,
 *         blocage ; contrôle que la caméra a bien bougé.
 *   leak  session longue : N cycles (ouvrir le projet, filtre Pente, vol
 *         lointain et retour, feuille de route, fermer) — tas JS après GC,
 *         nœuds DOM, écouteurs, instances Mapbox vivantes (Runtime.queryObjects).
 *   sw    cycle de vie du Service Worker (deux --root : build déployé puis
 *         suivant, même origine) — rechargements de page après l'ouverture
 *         d'un projet : première visite, nouvel onglet, rechargement,
 *         déploiement ; pipeline DEM du worker actif à chaque fois.
 *   big   ouverture de très gros projets (2 → 61 M car., `gz:` dans le
 *         document puis fichier du bucket au-delà de 12 M) sur un appareil
 *         neuf puis depuis la copie locale : temps jusqu'au tracé affiché,
 *         blocage total et plus longue tâche, profil CPU (`--profile`).
 *
 * Usage (après `npm run build:vite` avec les VITE_* du .env) :
 *   npx tsx script-test-bench/dashboard-perf/run.ts [--scenario load,map,leak,big]
 *     [--root <copie>]… (plusieurs = A/B entrelacé) [--network 4g-lent,fibre]
 *     [--runs 3] [--cycles 10] [--sizes 200x1,1200x1,1200x3,1200x6]
 *     [--channel msedge|chromium] [--headed] [--profile] [--verbose]
 *     [--block host1,host2] (hôtes coupés, pour un « et si ») [--login-only]
 * Rapport JSON : script-test-bench/reports/dashboard-perf/. Sortie non nulle
 * sur un contrôle en échec (erreur de page, appel Appwrite non simulé,
 * violation CSP, fuite, caméra immobile), jamais sur un temps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import { BENCH_USER, NETWORK_PROFILES, installBackend, launchBrowser, startAppServer, summarize } from './harness.mjs';
import { PAGE_PROBE } from './pageProbe.mjs';
import { startThrottleProxy } from './throttleProxy.mjs';
import { originalPosition } from './sourceMap.ts';
import { buildBenchProject, type BenchProjectRow, type BenchProjectSpec } from './projectFixture.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_DIR = path.join(REPO, 'script-test-bench', 'reports', 'dashboard-perf');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type NetworkProfile = { rttMs: number; downKbps: number; upKbps: number };

// ── Arguments ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const values = (name: string) => argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1]] : []));
const value = (name: string, fallback: string) => values(name)[0] ?? fallback;
const flag = (name: string) => argv.includes(name);
const SCENARIOS = value('--scenario', 'load,map,leak,big').split(',');
const ROOTS = (values('--root').length ? values('--root') : [REPO]).map((root) => path.resolve(root));
const NETWORKS = value('--network', '4g-lent,fibre').split(',');
const RUNS = Number(value('--runs', '3'));
const CYCLES = Number(value('--cycles', '10'));
const SIZES = value('--sizes', '200x1,1200x1,1200x3,1200x6').split(',');
const CHANNEL = value('--channel', 'msedge');
const HEADED = flag('--headed');
const PROFILE = flag('--profile');
/** Hôtes coupés (« et si » : ex. `--block analytics.redview.tech` = sans le script Umami). */
const BLOCKED_HOSTS = value('--block', '').split(',').filter(Boolean);
/** `load` réduit à l'écran de connexion (premier rendu), sans ouvrir de projet. */
const LOGIN_ONLY = flag('--login-only');

// ── Contrôles ──────────────────────────────────────────────────────────────
const failures: string[] = [];
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ''}`);
}

const ms = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? '—' : value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} Mo`;

// ── Projets de banc ────────────────────────────────────────────────────────
const fixtures = new Map<string, BenchProjectRow>();
function fixture(size: string): BenchProjectRow {
  const cached = fixtures.get(size);
  if (cached) return cached;
  const [km, variants] = size.split('x').map(Number);
  const spec: BenchProjectSpec = {
    id: `bench${km}x${variants}`,
    name: `Banc ${km} km × ${variants}`,
    km,
    variants,
    poisPerVariant: km >= 1000 ? 1500 : 200,
    prediction: true,
  };
  const row = buildBenchProject(spec, BENCH_USER.$id);
  fixtures.set(size, row);
  return row;
}

type Backend = Awaited<ReturnType<typeof installBackend>>;
function seed(backend: Backend, rows: BenchProjectRow[]) {
  for (const row of rows) {
    backend.appwrite.putDocument('projects', row.spec.id, row.attributes);
    backend.appwrite.putDocument('project_views', row.view.id, row.view.attributes);
    if (row.payloadFile) backend.appwrite.putFile('project-payloads', row.payloadFile.id, row.payloadFile.bytes);
  }
}

// ── Session navigateur ─────────────────────────────────────────────────────
interface Session {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  backend: Backend;
  errors: string[];
  close: () => Promise<void>;
}

async function openSession(root: string, origin: string, options: { loggedIn: boolean; network?: NetworkProfile | null; proxy?: string | null; rows?: BenchProjectRow[] }): Promise<Session> {
  const browser = await launchBrowser({ channel: CHANNEL, headless: !HEADED, proxy: options.proxy ?? null });
  const { context } = browser;
  const backend = await installBackend(context, { root, origin, loggedIn: options.loggedIn, network: options.network ?? null });
  seed(backend, options.rows ?? []);
  for (const host of BLOCKED_HOSTS) await context.route(`https://${host}/**`, (route) => route.abort());
  await context.addInitScript(PAGE_PROBE);
  const page = context.pages()[0] ?? await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  page.on('crash', () => errors.push('onglet planté'));
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp, backend, errors, close: browser.close };
}

/**
 * `page.evaluate` borné : sans délai, une page figée (fil principal bloqué,
 * rendu planté) tenait le banc indéfiniment.
 */
async function evaluate<T>(page: Page, expression: string, timeoutMs = 10_000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(expression) as Promise<T>,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Étape en cours (affichée quand `--verbose`), pour voir où un passage s'attarde. */
const VERBOSE = flag('--verbose');
const stepStart = performance.now();
function step(label: string) {
  if (VERBOSE) console.log(`    · ${((performance.now() - stepStart) / 1000).toFixed(1)} s ${label}`);
}

/** Attend qu'une expression de page soit vraie ; renvoie l'instant (ms, horloge Node) ou null. */
async function until(page: Page, expression: string, timeoutMs: number, intervalMs = 50): Promise<number | null> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const ok = await evaluate<boolean>(page, expression);
    if (ok) return performance.now();
    await sleep(intervalMs);
  }
  return null;
}

const LOGIN_VISIBLE = `(() => { const el = document.querySelector('input[type=email]'); return !!el && el.offsetParent !== null; })()`;
const projectCard = (name: string) => `[...document.querySelectorAll('[data-rv-project-card]')].some((card) => card.textContent.includes(${JSON.stringify(name)}))`;
/** Carte prête trois sondages de suite (≥ 150 ms) avec le tracé : chargement fini, pas un creux entre deux vagues. */
async function untilMapReady(page: Page, timeoutMs: number): Promise<number | null> {
  const deadline = performance.now() + timeoutMs;
  let streak = 0;
  let firstReadyAt = 0;
  while (performance.now() < deadline) {
    const state = await evaluate<{ ready: boolean; route: boolean }>(page, 'window.__rvMapState?.()');
    if (state?.ready && state.route) {
      if (streak === 0) firstReadyAt = performance.now();
      if (++streak >= 3) return firstReadyAt;
    } else {
      streak = 0;
    }
    await sleep(50);
  }
  return null;
}

async function clickOpen(page: Page, name: string) {
  const card = page.locator('[data-rv-project-card]', { hasText: name }).first();
  await card.hover();
  await card.locator('button.rvpb-card__open, button.rvpb-card__preview').first().click();
}

interface Blocking { totalMs: number; longestMs: number; count: number }
async function blockingSince(page: Page, sinceMs: number): Promise<Blocking> {
  const loafs = (await evaluate<Array<[number, number, number]>>(page, 'window.__rvPerf?.loafs ?? []')) ?? [];
  const recent = loafs.filter(([start]) => start >= sinceMs);
  return {
    totalMs: recent.reduce((sum, [, , blocking]) => sum + blocking, 0),
    longestMs: recent.reduce((max, [, duration]) => Math.max(max, duration), 0),
    count: recent.length,
  };
}

function checkSession(label: string, session: Session) {
  const { state } = session.backend.appwrite;
  check(`${label} : aucun appel Appwrite non simulé`, state.unhandled.length === 0, state.unhandled.slice(0, 3).join(', '));
  check(`${label} : aucune exception de page`, session.errors.length === 0, session.errors.slice(0, 2).join(' | '));
  check(`${label} : aucune violation CSP`, session.backend.telemetry.cspReports.length === 0, session.backend.telemetry.cspReports.slice(0, 3).join(' | '));
  check(`${label} : aucune erreur envoyée à GlitchTip`, session.backend.telemetry.errors.length === 0, session.backend.telemetry.errors.slice(0, 2).join(' | '));
}

function hostClass(host: string, origin: string) {
  if (host === new URL(origin).host) return 'app';
  if (/mapbox\.com$/.test(host)) return 'mapbox';
  if (/amazonaws\.com$|ign\.fr$|geo\.admin\.ch$/.test(host)) return 'tuiles';
  if (/googleapis\.com$|gstatic\.com$/.test(host)) return 'polices';
  return 'autres';
}

// ── Scénario load ──────────────────────────────────────────────────────────
async function scenarioLoad(servers: Map<string, { origin: string }>) {
  const project = fixture('200x1');
  const results: Record<string, unknown>[] = [];
  // Premier lancement du navigateur et premières requêtes du serveur : jusqu'à
  // 5 s de plus sur le premier passage (FCP 0,6 → 4,9 s), jamais compté.
  for (const root of ROOTS) {
    const warmup = await openSession(root, servers.get(root)!.origin, { loggedIn: false });
    await warmup.page.goto(servers.get(root)!.origin);
    await until(warmup.page, LOGIN_VISIBLE, 60_000);
    await warmup.close();
  }
  for (const networkName of NETWORKS) {
    const network = NETWORK_PROFILES[networkName as keyof typeof NETWORK_PROFILES];
    if (!network) throw new Error(`profil réseau inconnu : ${networkName}`);
    console.log(`\n▶ load · ${networkName} (${network.rttMs} ms, ${network.downKbps / 1000} Mbit/s)`);
    for (let run = 0; run < RUNS; run++) {
      for (const root of ROOTS) {
        const { origin } = servers.get(root)!;
        const proxy = await startThrottleProxy(network);
        const row: Record<string, unknown> = { scenario: 'load', network: networkName, run, root };
        try {
          // 1. Visiteur non connecté : écran de connexion.
          let session = await openSession(root, origin, { loggedIn: false, network, proxy: proxy.url });
          try {
            const t0 = performance.now();
            await session.page.goto(origin, { waitUntil: 'commit' });
            step('connexion : navigation');
            const login = await until(session.page, LOGIN_VISIBLE, 120_000);
            step(`connexion : écran ${login == null ? 'jamais affiché' : 'affiché'}`);
            await sleep(300);
            const paints = (await evaluate<{ fcp: number | null; lcp: number | null }>(session.page, '({ fcp: window.__rvPerf?.fcp, lcp: window.__rvPerf?.lcp })')) ?? { fcp: null, lcp: null };
            row.loginMs = login == null ? null : login - t0;
            row.fcpMs = paints.fcp;
            row.lcpMs = paints.lcp;
            row.loginBytes = [...proxy.bytesByHost.values()].reduce((a, b) => a + b, 0);
            row.loginBlocking = await blockingSince(session.page, 0);
            checkSession(`load ${networkName} #${run} connexion`, session);
          } finally {
            await session.close();
          }
          proxy.resetCounters();

          // 2. Utilisateur connecté, appareil neuf : liste des projets, ouverture, carte prête.
          if (!LOGIN_ONLY) session = await openSession(root, origin, { loggedIn: true, network, proxy: proxy.url, rows: [project] });
          if (!LOGIN_ONLY) try {
            const t0 = performance.now();
            await session.page.goto(origin, { waitUntil: 'commit' });
            const list = await until(session.page, projectCard(project.spec.name), 120_000);
            step(`liste : ${list == null ? 'jamais affichée' : 'affichée'}`);
            row.projectListMs = list == null ? null : list - t0;
            const openedAt = performance.now();
            await clickOpen(session.page, project.spec.name);
            const editor = await until(session.page, `!!document.querySelector('.mapboxgl-canvas')`, 120_000);
            step(`éditeur : ${editor == null ? 'jamais monté' : 'monté'}`);
            const ready = await untilMapReady(session.page, 180_000);
            step(`carte : ${ready == null ? 'jamais prête' : 'prête'}`);
            row.editorMs = editor == null ? null : editor - openedAt;
            row.mapReadyMs = ready == null ? null : ready - openedAt;
            const camera = (await evaluate<{ zoom: number }>(session.page, 'window.__rvMapState()')) ?? { zoom: NaN };
            check(`load ${networkName} #${run} : vue enregistrée appliquée`, Math.abs(camera.zoom - project.viewport.zoom) < 0.75, `zoom ${camera.zoom.toFixed(2)} / ${project.viewport.zoom}`);
            const byClass: Record<string, number> = {};
            for (const [host, bytes] of proxy.bytesByHost) byClass[hostClass(host, origin)] = (byClass[hostClass(host, origin)] ?? 0) + bytes;
            row.openBytes = byClass;

            // 3. Visite suivante (cache HTTP, Service Worker, copie locale) : rechargement du projet ouvert.
            proxy.resetCounters();
            const t1 = performance.now();
            await session.page.reload({ waitUntil: 'commit' });
            const warm = await untilMapReady(session.page, 180_000);
            step(`à chaud : ${warm == null ? 'jamais prête' : 'prête'}`);
            row.warmMapReadyMs = warm == null ? null : warm - t1;
            row.warmBytes = [...proxy.bytesByHost.values()].reduce((a, b) => a + b, 0);
            checkSession(`load ${networkName} #${run} projet`, session);
          } finally {
            await session.close();
          }
        } finally {
          await proxy.stop();
        }
        const login = `connexion ${ms(row.loginMs as number)} (FCP ${ms(row.fcpMs as number)}, LCP ${ms(row.lcpMs as number)}, ${mb(row.loginBytes as number)})`;
        console.log(LOGIN_ONLY
          ? `  ${path.basename(root)} #${run} : ${login}`
          : `  ${path.basename(root)} #${run} : ${login} · liste ${ms(row.projectListMs as number)} · éditeur ${ms(row.editorMs as number)} · carte ${ms(row.mapReadyMs as number)} · à chaud ${ms(row.warmMapReadyMs as number)} (${mb(row.warmBytes as number)})`);
        results.push(row);
      }
    }
    for (const root of ROOTS) {
      const rows = results.filter((r) => r.network === networkName && r.root === root);
      const median = (key: string) => summarize(rows.map((r) => r[key] as number).filter((v) => Number.isFinite(v))).p50;
      console.log(LOGIN_ONLY
        ? `  médianes ${path.basename(root)} : connexion ${ms(median('loginMs'))} · FCP ${ms(median('fcpMs'))} · LCP ${ms(median('lcpMs'))}`
        : `  médianes ${path.basename(root)} : connexion ${ms(median('loginMs'))} · LCP ${ms(median('lcpMs'))} · liste ${ms(median('projectListMs'))} · carte ${ms(median('mapReadyMs'))} · à chaud ${ms(median('warmMapReadyMs'))}`);
    }
    check(`load ${networkName} : chaque étape atteinte`, results.filter((r) => r.network === networkName).every((r) => r.loginMs != null && (LOGIN_ONLY || (r.projectListMs != null && r.mapReadyMs != null && r.warmMapReadyMs != null))));
  }
  return results;
}

// ── Scénario map ───────────────────────────────────────────────────────────
interface FrameStats { frames: number; p50: number; p95: number; max: number; over33: number; blockingMs: number }

type MapPoint = { x: number; y: number; width: number; height: number };

async function measureGesture(session: Session, gesture: (page: Page, at: MapPoint) => Promise<void>): Promise<FrameStats | null> {
  const { page } = session;
  const at = await evaluate<MapPoint>(page, 'window.__rvMapPoint()');
  if (!at) return null;
  const since = (await evaluate<number>(page, 'performance.now()')) ?? 0;
  await evaluate(page, 'window.__rvFrames.start()');
  await gesture(page, at);
  await sleep(300);
  const stamps = (await evaluate<number[]>(page, 'window.__rvFrames.stop()')) ?? [];
  const intervals = stamps.slice(1).map((t, i) => t - stamps[i]);
  const s = summarize(intervals);
  const blocking = await blockingSince(page, since);
  return { frames: stamps.length, p50: s.p50, p95: s.p95, max: s.max, over33: intervals.filter((v) => v > 33.4).length, blockingMs: blocking.totalMs };
}

/** Glisser sur ~1,5 s (90 pas de 16 ms), en restant dans la partie visible. */
async function pan(page: Page, at: MapPoint) {
  const reach = Math.min(240, at.width * 0.35);
  await page.mouse.move(at.x + reach, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 90; i++) {
    await page.mouse.move(at.x + reach - (2 * reach * i) / 90, at.y + Math.sin(i / 14) * Math.min(60, at.height * 0.2));
    await sleep(16);
  }
  await page.mouse.up();
}

async function wheelZoom(page: Page, at: MapPoint) {
  await page.mouse.move(at.x, at.y);
  // 24 crans avant, 16 arrière : un aller-retour exact ne changerait pas le zoom final.
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, i < 24 ? -120 : 120);
    await sleep(30);
  }
}

/** Clic droit glissé : rotation et inclinaison (Mapbox), menu contextuel refermé ensuite. */
async function rotate(page: Page, at: MapPoint) {
  const reach = Math.min(200, at.width * 0.3);
  await page.mouse.move(at.x - reach / 2, at.y);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 90; i++) {
    await page.mouse.move(at.x - reach / 2 + (reach * i) / 90, at.y - (i / 90) * Math.min(60, at.height * 0.2));
    await sleep(16);
  }
  await page.mouse.up({ button: 'right' });
  await page.keyboard.press('Escape');
}

async function scenarioMap(servers: Map<string, { origin: string }>) {
  const project = fixture('1200x1');
  const results: Record<string, unknown>[] = [];
  console.log(`\n▶ map · ${project.spec.name} (${(project.documentChars / 1e6).toFixed(1)} M car.)`);
  for (let run = 0; run < RUNS; run++) {
    for (const root of ROOTS) {
      const { origin } = servers.get(root)!;
      const session = await openSession(root, origin, { loggedIn: true, rows: [project] });
      try {
        await session.page.goto(origin);
        await until(session.page, projectCard(project.spec.name), 60_000);
        await clickOpen(session.page, project.spec.name);
        check(`map #${run} : carte prête`, (await untilMapReady(session.page, 120_000)) != null);
        await sleep(3000);
        const row: Record<string, unknown> = { scenario: 'map', run, root };
        for (const [name, gesture] of [['déplacement', pan], ['zoom molette', wheelZoom], ['rotation', rotate]] as const) {
          const before = (await evaluate<Record<string, number>>(session.page, 'window.__rvMapState()')) ?? {};
          const stats = await measureGesture(session, gesture);
          const after = (await evaluate<Record<string, number>>(session.page, 'window.__rvMapState()')) ?? {};
          if (!stats) {
            check(`map #${run} ${name} : partie visible de la carte trouvée`, false);
            continue;
          }
          const moved = Math.abs(after.lng - before.lng) + Math.abs(after.lat - before.lat) > 1e-4
            || Math.abs(after.zoom - before.zoom) > 0.05 || Math.abs(after.bearing - before.bearing) > 1 || Math.abs(after.pitch - before.pitch) > 1;
          check(`map #${run} ${name} : la caméra a bougé`, moved);
          row[name] = stats;
          console.log(`  ${path.basename(root)} #${run} ${name} : ${stats.frames} images, intervalle p50 ${stats.p50.toFixed(1)} / p95 ${stats.p95.toFixed(1)} / max ${stats.max.toFixed(0)} ms, > 33 ms : ${stats.over33}, blocage ${ms(stats.blockingMs)}`);
          await untilMapReady(session.page, 30_000);
          await sleep(1000);
        }
        checkSession(`map #${run}`, session);
        results.push(row);
      } finally {
        await session.close();
      }
    }
  }
  return results;
}

// ── Scénario leak ──────────────────────────────────────────────────────────
interface MemorySample { cycle: number; heapMb: number; nodes: number; listeners: number; mapboxMaps: number; documents: number }

async function memorySample(session: Session, cycle: number, mapPrototype: string | null): Promise<MemorySample> {
  const { cdp } = session;
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const metric = (name: string) => metrics.find((m) => m.name === name)?.value ?? NaN;
  let mapboxMaps = -1;
  if (mapPrototype) {
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: mapPrototype, objectGroup: 'leak' });
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId!, functionDeclaration: 'function () { return this.length; }', returnByValue: true });
    mapboxMaps = result.value as number;
    await cdp.send('Runtime.releaseObject', { objectId: objects.objectId! });
  }
  return { cycle, heapMb: metric('JSHeapUsedSize') / 1e6, nodes: metric('Nodes'), listeners: metric('JSEventListeners'), mapboxMaps, documents: metric('Documents') };
}

/** Pente (Mo/cycle) de la droite des moindres carrés. */
function slope(points: Array<[number, number]>) {
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const num = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const den = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  return den ? num / den : 0;
}

async function toggleChip(page: Page, label: RegExp) {
  await page.locator('.rvd-place-search__filter-toggle', { hasText: label }).first().click({ timeout: 5000 });
}

/** Retour au gestionnaire de projets (croix de l'en-tête du panneau). */
async function closeProject(page: Page) {
  await page.locator('button.rvi-header__back').click({ timeout: 10_000 });
}

async function scenarioLeak(servers: Map<string, { origin: string }>) {
  const project = fixture('200x1');
  const results: Record<string, unknown>[] = [];
  console.log(`\n▶ leak · ${CYCLES} cycles`);
  for (const root of ROOTS) {
    const { origin } = servers.get(root)!;
    const session = await openSession(root, origin, { loggedIn: true, rows: [project] });
    const { page, cdp } = session;
    try {
      await cdp.send('Performance.enable');
      await page.goto(origin);
      await until(page, projectCard(project.spec.name), 60_000);
      let mapPrototype: string | null = null;
      const samples: MemorySample[] = [await memorySample(session, 0, null)];
      for (let cycle = 1; cycle <= CYCLES; cycle++) {
        await clickOpen(page, project.spec.name);
        const ready = await untilMapReady(page, 120_000);
        if (ready == null) {
          check(`leak cycle ${cycle} : carte prête`, false);
          break;
        }
        if (!mapPrototype) {
          const { result } = await cdp.send('Runtime.evaluate', { expression: 'Object.getPrototypeOf(window.__rvMap())', objectGroup: 'leak-proto' });
          mapPrototype = result.objectId ?? null;
        }
        // Filtre Pente (overlay du Service Worker), aller et retour.
        await toggleChip(page, /Pente|Slope/);
        await untilMapReady(page, 30_000);
        await toggleChip(page, /Pente|Slope/);
        // Vol lointain puis retour (tuiles, étiquettes, terrain à recharger).
        await evaluate(page, `(() => { const m = window.__rvMap(); window.__rvHome = m.getCenter(); m.jumpTo({ center: [2.35, 48.85], zoom: 11 }); })()`);
        await untilMapReady(page, 60_000);
        await evaluate(page, `window.__rvMap().jumpTo({ center: window.__rvHome, zoom: 9 })`);
        await untilMapReady(page, 60_000);
        // Feuille de route en plein écran, ouverte puis fermée.
        const roadbook = page.getByRole('button', { name: /Feuille de route en plein écran|Full-screen roadbook/ }).first();
        if (await roadbook.isVisible().catch(() => false)) {
          await roadbook.click();
          await sleep(800);
          await page.keyboard.press('Escape');
          await sleep(300);
        }
        // Fermer le projet : retour à la liste.
        await closeProject(page);
        await until(page, projectCard(project.spec.name), 30_000);
        await sleep(1500);
        const sample = await memorySample(session, cycle, mapPrototype);
        samples.push(sample);
        console.log(`  ${path.basename(root)} cycle ${cycle} : tas ${sample.heapMb.toFixed(1)} Mo · nœuds ${sample.nodes} · écouteurs ${sample.listeners} · cartes Mapbox vivantes ${sample.mapboxMaps}`);
      }
      const steady = samples.filter((s) => s.cycle >= 3);
      const heapSlope = steady.length >= 3 ? slope(steady.map((s) => [s.cycle, s.heapMb])) : 0;
      const nodeSlope = steady.length >= 3 ? slope(steady.map((s) => [s.cycle, s.nodes])) : 0;
      const last = samples[samples.length - 1];
      check(`leak ${path.basename(root)} : ${CYCLES} cycles faits`, samples.length === CYCLES + 1);
      check(`leak ${path.basename(root)} : tas stable après 2 cycles`, heapSlope < 1.5, `${heapSlope.toFixed(2)} Mo/cycle`);
      check(`leak ${path.basename(root)} : nœuds DOM stables`, nodeSlope < 200, `${nodeSlope.toFixed(0)} nœuds/cycle`);
      check(`leak ${path.basename(root)} : aucune carte Mapbox gardée après fermeture`, last.mapboxMaps <= 0, `${last.mapboxMaps} vivante(s)`);
      checkSession(`leak ${path.basename(root)}`, session);
      results.push({ scenario: 'leak', root, samples, heapSlopeMbPerCycle: heapSlope, nodeSlopePerCycle: nodeSlope });
    } finally {
      await session.close();
    }
  }
  return results;
}

// ── Scénario big ───────────────────────────────────────────────────────────
interface ProfileSummary { totalMs: number; top: Array<{ fn: string; selfMs: number }>; modules: Array<{ module: string; selfMs: number }> }

/**
 * Temps propre par fonction et par module source : positions du build
 * ramenées à la source par les sourcemaps de `root/dist` (sourceMap.ts),
 * le nom minifié sinon.
 */
function summariseProfile(
  profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number } }>; samples: number[]; timeDeltas: number[] },
  root: string,
): ProfileSummary {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map<string, number>();
  const modules = new Map<string, number>();
  const where = new Map<number, string>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    total += dt;
    if (!node) return;
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    if (functionName === '(idle)' || functionName === '(program)') return;
    let key = where.get(id);
    if (!key) {
      let resolved: string | null = null;
      if (url.startsWith('http')) {
        const file = path.join(root, 'dist', new URL(url).pathname);
        resolved = originalPosition(file, lineNumber, columnNumber);
      }
      key = resolved ?? `${functionName || '(anonyme)'} ${url ? url.split('/').pop() : ''}:${lineNumber + 1}`;
      where.set(id, key);
    }
    self.set(key, (self.get(key) ?? 0) + dt);
    const module = key.split(':')[0];
    modules.set(module, (modules.get(module) ?? 0) + dt);
  });
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([fn, selfMs]) => ({ fn, selfMs }));
  const byModule = [...modules].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([module, selfMs]) => ({ module, selfMs }));
  return { totalMs: total, top, modules: byModule };
}

async function scenarioBig(servers: Map<string, { origin: string }>) {
  const results: Record<string, unknown>[] = [];
  console.log('\n▶ big');
  for (const size of SIZES) {
    const project = fixture(size);
    console.log(`  ${project.spec.name} : document ${(project.documentChars / 1e6).toFixed(1)} M car., gzip ${mb(project.gzipBytes)}, ${project.payloadFile ? 'fichier du bucket' : '`gz:` dans le document'}`);
    for (let run = 0; run < RUNS; run++) {
      for (const root of ROOTS) {
        const { origin } = servers.get(root)!;
        const network = NETWORK_PROFILES.fibre;
        const session = await openSession(root, origin, { loggedIn: true, network, rows: [project] });
        const { page, cdp } = session;
        const row: Record<string, unknown> = { scenario: 'big', size, run, root, documentChars: project.documentChars, gzipBytes: project.gzipBytes };
        try {
          await page.goto(origin);
          await until(page, projectCard(project.spec.name), 60_000);
          // Éditeur déjà chargé une fois (cache HTTP) : seul le coût du projet reste.
          for (const [phase, cold] of [['appareil neuf', true], ['copie locale', false]] as const) {
            if (PROFILE && run === 0) {
              await cdp.send('Profiler.enable');
              await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
              await cdp.send('Profiler.start');
            }
            const since = (await evaluate<number>(page, 'performance.now()')) ?? 0;
            const t0 = performance.now();
            await clickOpen(page, project.spec.name);
            const editor = await until(page, `!!document.querySelector('.mapboxgl-canvas')`, 120_000);
            const route = await until(page, `window.__rvMapState?.().route === true`, 240_000);
            const ready = await untilMapReady(page, 240_000);
            await sleep(1500);
            const blocking = await blockingSince(page, since);
            const key = cold ? 'cold' : 'warm';
            row[key] = { editorMs: editor && editor - t0, routeMs: route && route - t0, readyMs: ready && ready - t0, blocking };
            if (PROFILE && run === 0) {
              const { profile } = await cdp.send('Profiler.stop');
              const summary = summariseProfile(profile as never, root);
              row[`${key}Profile`] = summary;
              console.log(`      profil ${phase} (${ms(summary.totalMs)} échantillonnés) — modules : ${summary.modules.slice(0, 6).map((m) => `${m.module} ${ms(m.selfMs)}`).join(' · ')}`);
              for (const fn of summary.top.slice(0, 8)) console.log(`        ${ms(fn.selfMs).padStart(7)}  ${fn.fn}`);
            }
            console.log(`    ${path.basename(root)} #${run} ${phase} : éditeur ${ms(editor && editor - t0)} · tracé ${ms(route && route - t0)} · carte prête ${ms(ready && ready - t0)} · blocage ${ms(blocking.totalMs)} (plus longue image ${ms(blocking.longestMs)})`);
            check(`big ${size} #${run} ${phase} : tracé affiché`, route != null);
            await closeProject(page);
            await until(page, projectCard(project.spec.name), 60_000);
            await sleep(1000);
          }
          checkSession(`big ${size} #${run}`, session);
        } finally {
          await session.close();
        }
        results.push(row);
      }
    }
  }
  return results;
}

// ── Scénario sw ────────────────────────────────────────────────────────────
/**
 * Cycle de vie du Service Worker vu par un même navigateur : première visite,
 * nouvel onglet, rechargement, puis déploiement d'un autre build (`--root`
 * suivant, même port donc même origine) et nouvel onglet après. Compte les
 * documents rechargés par l'app après l'ouverture du projet (l'époque du
 * cache de carte recharge la page une fois quand un ancien worker la
 * servait) et contrôle que le pipeline DEM du worker est actif (contrôleur à
 * l'époque du build, source `/dem-tiles/`).
 */
async function scenarioSw() {
  if (ROOTS.length < 2) throw new Error('--scenario sw : deux --root au moins (build déployé, puis build suivant)');
  const project = fixture('200x1');
  const results: Record<string, unknown>[] = [];
  console.log(`\n▶ sw · ${ROOTS.map((root) => path.basename(root)).join(' → ')}`);
  let server = await startAppServer(ROOTS[0]);
  const { port } = server;
  const browser = await launchBrowser({ channel: CHANNEL, headless: !HEADED });
  const { context } = browser;
  try {
    const backend = await installBackend(context, { root: ROOTS[0], origin: server.origin, loggedIn: true });
    seed(backend, [project]);
    await context.addInitScript(PAGE_PROBE);
    let page = context.pages()[0] ?? await context.newPage();

    const visit = async (label: string, mode: 'open' | 'reload', expectedReloads: number) => {
      let documents = 0;
      const onLoad = () => { documents++; };
      page.on('domcontentloaded', onLoad);
      const t0 = performance.now();
      if (mode === 'reload') {
        await page.reload({ waitUntil: 'commit' });
      } else {
        await page.goto(server.origin, { waitUntil: 'commit' });
        await until(page, projectCard(project.spec.name), 60_000);
      }
      if (mode === 'open') await clickOpen(page, project.spec.name);
      const ready = await untilMapReady(page, 120_000);
      // Le repli de l'époque recharge jusqu'à 2,5 s après l'enregistrement.
      await sleep(4000);
      const settled = await untilMapReady(page, 60_000);
      // Depuis la navigation : l'éditeur est préchargé au repos, l'enregistrement
      // du worker (et un rechargement) peut précéder le clic.
      const reloads = documents - 1;
      const state = (await evaluate<{ epoch: string | null; demTiles: boolean }>(page, `(() => {
        const controller = navigator.serviceWorker?.controller;
        const epoch = controller ? new URL(controller.scriptURL).searchParams.get('rv-map-cache-epoch') : null;
        const map = window.__rvMap();
        const sources = map ? Object.values(map.getStyle()?.sources ?? {}) : [];
        const demTiles = sources.some((s) => (s.tiles ?? []).some((t) => String(t).includes('/dem-tiles/')));
        return { epoch, demTiles };
      })()`)) ?? { epoch: null, demTiles: false };
      const row = { label, reloads, readyMs: ready && ready - t0, settled: settled != null, ...state };
      results.push(row);
      console.log(`  ${label} : ${reloads} rechargement(s) · carte prête ${ms(row.readyMs)} · contrôleur ${state.epoch ?? 'aucun'} · tuiles DEM du worker ${state.demTiles ? 'oui' : 'non'}`);
      check(`sw ${label} : ${expectedReloads} rechargement attendu`, reloads === expectedReloads, `${reloads}`);
      check(`sw ${label} : carte prête, pipeline DEM du worker actif`, settled != null && state.epoch != null && state.demTiles);
      page.off('domcontentloaded', onLoad);
    };

    await visit(`${path.basename(ROOTS[0])} première visite`, 'open', 0);
    page = await context.newPage();
    await visit(`${path.basename(ROOTS[0])} nouvel onglet`, 'open', 0);
    await visit(`${path.basename(ROOTS[0])} rechargement`, 'reload', 0);
    for (const next of ROOTS.slice(1)) {
      await server.stop();
      server = await startAppServer(next, { port });
      page = await context.newPage();
      // Le worker du build précédent sert encore la page : un rechargement pour passer au nouveau.
      await visit(`${path.basename(next)} après déploiement`, 'open', 1);
      page = await context.newPage();
      await visit(`${path.basename(next)} nouvel onglet après déploiement`, 'open', 0);
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  return results;
}

// ── Principal ──────────────────────────────────────────────────────────────
async function main() {
  const report: Record<string, unknown> = { date: new Date().toISOString(), roots: ROOTS, channel: CHANNEL, scenarios: {} };
  // `sw` lance ses builds lui-même, l'un après l'autre sur la même origine.
  if (SCENARIOS.includes('sw')) (report.scenarios as Record<string, unknown>).sw = await scenarioSw();
  const others = SCENARIOS.filter((scenario) => scenario !== 'sw');
  const servers = new Map<string, { origin: string; stop: () => Promise<void> }>();
  try {
    if (others.length) {
      for (const root of ROOTS) servers.set(root, await startAppServer(root));
      console.log(`Build(s) : ${ROOTS.map((root) => `${path.basename(root)} → ${servers.get(root)!.origin}`).join(' · ')} · navigateur ${CHANNEL}`);
    }
    for (const scenario of others) {
      const run = { load: scenarioLoad, map: scenarioMap, leak: scenarioLeak, big: scenarioBig }[scenario];
      if (!run) throw new Error(`scénario inconnu : ${scenario}`);
      (report.scenarios as Record<string, unknown>)[scenario] = await run(servers);
    }
  } finally {
    for (const server of servers.values()) await server.stop();
  }
  report.failures = failures;
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, `dashboard-perf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nRapport : ${path.relative(REPO, file)}`);
  console.log(failures.length === 0 ? 'Tous les contrôles passent.' : `${failures.length} contrôle(s) en échec :\n  - ${failures.join('\n  - ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
