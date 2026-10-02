/**
 * Routing-quality bench — passe complète sur le vrai pipeline de l'app.
 *
 *   npm run bench:routing -- --label before [--filter road-vitesse] [--band 100-200]
 *                            [--family vélo] [--concurrency 2] [--upstream 2] [--force]
 *                            [--set gravel-other]   (jeu ad hoc de scenarios.ts, EXTRA_SETS)
 *
 * Pré-requis : tunnel vers le BRouter du VPS (nginx /brouter est fermé au public)
 *   ssh -i ~/.ssh/oracle_brouter.key -N -L 27777:127.0.0.1:17777 opc@141.145.220.99
 * (`BENCH_BROUTER_UPSTREAM` pour une autre cible).
 *
 * Résultats : script-test-bench/reports/routing-quality/<label>.json (+ .geo.json),
 * réécrits après chaque scénario — une passe interrompue reprend où elle s'était
 * arrêtée (`--force` pour tout recalculer).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { closeLoader, ROOT } from '../audit/b-loader.ts';
import { buildItinerary, loadApp } from './app.ts';
import { computeRouteMetrics, simplifyCoords, type RouteMetrics } from './metrics.ts';
import { installProxyShim } from './proxy-shim.ts';
import { buildExtraScenarios, buildScenarios, type Band, type Scenario } from './scenarios.ts';

export const REPORT_DIR = path.join(ROOT, 'script-test-bench', 'reports', 'routing-quality');
const SCENARIO_TIMEOUT_MS = 180_000;

export interface ScenarioResult {
  id: string;
  routeId: string;
  routeLabel: string;
  terrain: string;
  configId: string;
  configLabel: string;
  family: string;
  band: Band;
  beelineKm: number;
  status: 'ok' | 'fallback' | 'error';
  error?: string;
  latencyMs: number;
  /** Téléchargement des réponses BRouter (tunnel), inclus dans latencyMs. */
  transferMs?: number;
  uploadMs: number | null;
  profileId: string | null;
  usedFallbackProfile: boolean;
  warnings: string[];
  maxSlopePct: number;
  upstreamRequests: number;
  metrics?: RouteMetrics;
}

export interface RunFile {
  label: string;
  gitHead: string;
  startedAt: string;
  updatedAt: string;
  upstream: string;
  results: Record<string, ScenarioResult>;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Écriture atomique avec nouveaux essais : sous Windows, un antivirus ou
 * l'indexeur peut verrouiller brièvement le fichier (EBUSY / UNKNOWN).
 */
function writeFileRobust(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 5) {
        console.warn(`[routing-quality] écriture impossible (${(error as Error).message}) — on continue`);
        return;
      }
      const until = Date.now() + 200 * (attempt + 1);
      while (Date.now() < until) { /* attente active courte */ }
    }
  }
}

function gitHead(): string {
  if (process.env.BENCH_GIT_HEAD) return process.env.BENCH_GIT_HEAD;
  try {
    const head = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    const dirty = execSync('git status --porcelain -- src api', { cwd: ROOT }).toString().trim() ? '+dirty' : '';
    return head + dirty;
  } catch {
    return 'unknown';
  }
}

async function main() {
  const label = arg('label') ?? 'run';
  const filter = arg('filter');
  const band = arg('band');
  const family = arg('family');
  const force = process.argv.includes('--force');
  const verbose = process.argv.includes('--verbose');
  const concurrency = Math.max(1, Math.min(2, Number(arg('concurrency') ?? 1)));
  // Requêtes BRouter simultanées (les tracés ancrés en lancent 2 en parallèle).
  const upstreamSlots = Math.max(concurrency, Math.min(3, Number(arg('upstream') ?? 2)));
  const upstream = (process.env.BENCH_BROUTER_UPSTREAM ?? 'http://127.0.0.1:27777').replace(/\/+$/, '');
  process.env.BROUTER_UPSTREAM = upstream;

  const health = await fetch(`${upstream}/brouter?lonlats=5.72,45.18|5.75,45.2&profile=trekking&alternativeidx=0&format=geojson`).catch(() => null);
  if (!health?.ok) {
    console.error(`BRouter injoignable sur ${upstream} — tunnel SSH ouvert ?`);
    process.exit(2);
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outFile = path.join(REPORT_DIR, `${label}.json`);
  const geoFile = path.join(REPORT_DIR, `${label}.geo.json`);
  const run: RunFile = fs.existsSync(outFile) && !force
    ? JSON.parse(fs.readFileSync(outFile, 'utf8'))
    : { label, gitHead: gitHead(), startedAt: new Date().toISOString(), updatedAt: '', upstream, results: {} };
  const geo: Record<string, [number, number][]> = fs.existsSync(geoFile) && !force ? JSON.parse(fs.readFileSync(geoFile, 'utf8')) : {};
  const save = () => {
    run.updatedAt = new Date().toISOString();
    writeFileRobust(outFile, JSON.stringify(run, null, 1));
    writeFileRobust(geoFile, JSON.stringify(geo));
  };

  const app = await loadApp();
  const shim = installProxyShim(app.apiHandler, { maxConcurrent: upstreamSlots });

  const set = arg('set');
  const scenarios = (set ? buildExtraScenarios(set) : buildScenarios()).filter((s) =>
    (!filter || new RegExp(filter).test(s.id))
    && (!band || s.band === band)
    && (!family || s.config.family === family)
    && (force || !run.results[s.id] || run.results[s.id]!.status === 'error'),
  );
  console.log(`[routing-quality] ${label} — ${scenarios.length} scénarios, concurrence ${concurrency} (${upstreamSlots} requêtes BRouter max), amont ${upstream}`);

  const uploadMsByConfig = new Map<string, number>();
  let done = 0;

  const runOne = async (scenario: Scenario) => {
    const logStart = shim.log.length;
    const itinerary = buildItinerary(app, scenario.config);
    const maxSlopePct = Number(itinerary.roadTypes.maxSlopePercent ?? 99);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`bench timeout ${SCENARIO_TIMEOUT_MS} ms`)), SCENARIO_TIMEOUT_MS);
    const base: Omit<ScenarioResult, 'status' | 'latencyMs'> = {
      id: scenario.id,
      routeId: scenario.route.id,
      routeLabel: scenario.route.label,
      terrain: scenario.route.terrain,
      configId: scenario.config.id,
      configLabel: scenario.config.label,
      family: scenario.config.family,
      band: scenario.band,
      beelineKm: Math.round(scenario.beelineKm * 10) / 10,
      uploadMs: null,
      profileId: null,
      usedFallbackProfile: false,
      warnings: [],
      maxSlopePct,
      upstreamRequests: 0,
    };
    let result: ScenarioResult;
    try {
      // Upload du profil hors chronométrage (mis en cache par l'app ensuite).
      if (!uploadMsByConfig.has(scenario.config.id)) {
        const tu = performance.now();
        await app.resolveItineraryRouting(itinerary, ctrl.signal);
        uploadMsByConfig.set(scenario.config.id, Math.round(performance.now() - tu));
      }
      base.uploadMs = uploadMsByConfig.get(scenario.config.id) ?? null;
      const before = shim.log.length;
      const t0 = performance.now();
      const res = await app.resolveRouteRequest({
        itinerary,
        signal: ctrl.signal,
        requestBase: { start: scenario.route.start, end: scenario.route.end, via: scenario.route.via ?? [], signal: ctrl.signal },
        setRouteWarnings: () => {},
      });
      const latencyMs = Math.round(performance.now() - t0);
      base.upstreamRequests = shim.log.length - before;
      // Transferts sur le chemin critique : séquentiels, sauf les deux moitiés
      // parallèles des tracés ancrés (on ne retire que la plus longue).
      const calls = shim.log.slice(before).filter((call) => call.status > 0);
      const parallelSaving = calls.length >= 3 ? Math.min(...calls.slice(-2).map((call) => call.transferMs)) : 0;
      const transferMs = calls.reduce((total, call) => total + call.transferMs, 0) - parallelSaving;
      base.profileId = res.resolved.profileId;
      base.usedFallbackProfile = res.usedFallbackProfile;
      base.warnings = res.resolvedWarnings;
      result = {
        ...base,
        status: res.usedFallbackProfile ? 'fallback' : 'ok',
        latencyMs,
        transferMs,
        metrics: computeRouteMetrics(app.metricFns, res.route, scenario.beelineKm, maxSlopePct),
      };
      geo[scenario.id] = simplifyCoords(res.route.coordinates);
    } catch (error) {
      result = { ...base, status: 'error', latencyMs: 0, error: String((error as Error)?.message ?? error).slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
    run.results[scenario.id] = result;
    done += 1;
    const m = result.metrics;
    console.log(
      `${String(done).padStart(4)}/${scenarios.length} ${result.status.padEnd(8)} ${scenario.id.padEnd(48)} ${String(result.latencyMs).padStart(6)} ms`
      + (m ? `  ${m.distanceKm.toFixed(1)} km  D+ ${Math.round(m.ascentM)}  D- ${Math.round(m.descentM)}` : `  ${result.error}`),
    );
    if (verbose) {
      for (const call of shim.log.slice(logStart)) {
        const pass1 = /pass1coefficient=([\d.]+)/.exec(call.path)?.[1] ?? '-';
        console.log(`        ${call.method} ${call.status} ${String(call.ms).padStart(6)} ms (calcul ${call.ttfbMs}, transfert ${call.transferMs})  pass1=${pass1}`);
      }
    }
    save();
  };

  const queue = [...scenarios];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) await runOne(s);
    }),
  );

  shim.restore();
  await closeLoader();
  const all = Object.values(run.results);
  console.log(
    `\n[routing-quality] ${label}: ${all.filter((r) => r.status === 'ok').length} ok, `
    + `${all.filter((r) => r.status === 'fallback').length} repli stock, ${all.filter((r) => r.status === 'error').length} échecs → ${path.relative(ROOT, outFile)}`,
  );
}

main().catch(async (error) => {
  console.error(error);
  await closeLoader();
  process.exit(1);
});
