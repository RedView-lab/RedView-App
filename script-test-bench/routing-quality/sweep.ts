/**
 * Balayage du coefficient A* de BRouter (`pass1coefficient`, passe unique
 * `pass2coefficient=-1`) + passe exacte de référence (`pass2coefficient=0`).
 * Mesure, par tranche de distance, l'écart de coût à l'optimum du profil et
 * la latence → paliers du coefficient adaptatif.
 *
 *   npm run bench:routing:sweep [-- --filter road-vitesse] [--exact-max-km 260]
 *
 * Appels directs au BRouter (tunnel), le proxy forçant le coefficient. Les
 * profils sont produits et téléversés par le vrai pipeline de l'app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeLoader, ROOT } from '../audit/b-loader.ts';
import { buildItinerary, loadApp } from './app.ts';
import { installProxyShim } from './proxy-shim.ts';
import { buildScenarios, type Scenario } from './scenarios.ts';

const REPORT_DIR = path.join(ROOT, 'script-test-bench', 'reports', 'routing-quality');
/**
 * Poids relatifs à l'échelle de coût du profil (coût BRouter au mètre, mesuré
 * dans la passe « before ») : coefficient = poids × échelle. Le 3.5 d'avant
 * est ajouté pour référence.
 */
const WEIGHTS = [3.0, 2.2, 1.7, 1.4, 1.2, 1.05, 0.9];
const REQUEST_TIMEOUT_MS = 150_000;
/** Au-delà de cette latence, on n'essaie pas de coefficient plus bas (plus lent). */
const PRUNE_MS = 45_000;

const SWEEP: Record<string, string[]> = {
  'road-vitesse': ['grenoble-oisans', 'paris-fontainebleau', 'rennes-stmalo', 'dijon-beaune', 'lyon-grenoble', 'paris-rouen', 'clermont-lepuy', 'besancon-geneve', 'tours-poitiers', 'nice-digne', 'bordeaux-toulouse', 'lyon-marseille', 'clermont-montpellier', 'strasbourg-lyon', 'paris-nice', 'lille-perpignan', 'bordeaux-geneve'],
  'gravel-aventure': ['grenoble-oisans', 'paris-fontainebleau', 'rennes-stmalo', 'dijon-beaune', 'lyon-grenoble', 'paris-rouen', 'clermont-lepuy', 'besancon-geneve', 'tours-poitiers', 'nice-digne', 'bordeaux-toulouse', 'lyon-marseille', 'clermont-montpellier', 'strasbourg-lyon', 'paris-nice', 'lille-perpignan', 'bordeaux-geneve'],
  'road-comfort': ['paris-fontainebleau', 'dijon-beaune', 'lyon-grenoble', 'paris-rouen', 'tours-poitiers', 'bordeaux-toulouse', 'strasbourg-lyon', 'paris-nice'],
  'gravel-vitesse': ['rennes-stmalo', 'lyon-grenoble', 'clermont-lepuy', 'besancon-geneve', 'lyon-marseille', 'bordeaux-toulouse', 'bordeaux-geneve'],
  'mtb-comfort': ['grenoble-oisans', 'dijon-beaune', 'lyon-grenoble', 'clermont-lepuy', 'nice-digne', 'clermont-montpellier'],
  'running-vitesse': ['paris-eiffel-vincennes', 'marseille-aix', 'paris-fontainebleau', 'paris-orleans'],
  'trail-vitesse': ['chamonix-courmayeur', 'grenoble-chamrousse', 'annecy-albertville'],
};

export interface SweepPoint {
  /** Poids relatif (null : 3.5 historique ou passe exacte). */
  weight: number | null;
  coefficient: number;
  exact: boolean;
  ms: number;
  ok: boolean;
  error?: string;
  cost?: number;
  km?: number;
  ascentM?: number;
}

export interface SweepEntry {
  id: string;
  configId: string;
  routeId: string;
  band: string;
  beelineKm: number;
  profileId: string;
  /** Échelle de coût du profil (coût BRouter au mètre, passe « before »). */
  costScale: number;
  points: SweepPoint[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function route(upstream: string, scenario: Scenario, profileId: string, pass1: number, pass2: number, weight: number | null): Promise<SweepPoint> {
  const pts = [scenario.route.start, ...(scenario.route.via ?? []), scenario.route.end];
  const params = new URLSearchParams({
    lonlats: pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|'),
    profile: profileId,
    alternativeidx: '0',
    format: 'geojson',
    'profile:pass1coefficient': String(pass1),
    'profile:pass2coefficient': String(pass2),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const t0 = performance.now();
  const base = { weight, coefficient: pass1, exact: pass2 >= 0 };
  try {
    const res = await fetch(`${upstream}/brouter?${params}`, { signal: ctrl.signal });
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    if (!res.ok || !text.trimStart().startsWith('{')) return { ...base, ms, ok: false, error: text.slice(0, 160) };
    const props = JSON.parse(text).features?.[0]?.properties ?? {};
    return { ...base, ms, ok: true, cost: Number(props.cost), km: Number(props['track-length']) / 1000, ascentM: Number(props['filtered ascend']) };
  } catch (error) {
    return { ...base, ms: Math.round(performance.now() - t0), ok: false, error: String((error as Error).message ?? error).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const upstream = (process.env.BENCH_BROUTER_UPSTREAM ?? 'http://127.0.0.1:27777').replace(/\/+$/, '');
  process.env.BROUTER_UPSTREAM = upstream;
  const filter = arg('filter');
  const exactMaxKm = Number(arg('exact-max-km') ?? 170);
  const outFile = path.join(REPORT_DIR, 'sweep.json');
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const entries: Record<string, SweepEntry> = fs.existsSync(outFile) && !process.argv.includes('--force')
    ? JSON.parse(fs.readFileSync(outFile, 'utf8'))
    : {};

  // Échelle de coût par config : médiane du coût BRouter au mètre (passe before).
  const before = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, 'before.json'), 'utf8')) as { results: Record<string, { configId: string; status: string; metrics?: { cost: number | null; distanceKm: number } }> };
  const scaleOf = (configId: string): number => {
    const cpm = Object.values(before.results)
      .filter((r) => r.configId === configId && r.status === 'ok' && r.metrics?.cost)
      .map((r) => r.metrics!.cost! / (r.metrics!.distanceKm * 1000))
      .sort((a, b) => a - b);
    return cpm.length ? cpm[Math.floor(cpm.length / 2)]! : 2;
  };

  const app = await loadApp();
  const shim = installProxyShim(app.apiHandler);
  const scenarios = buildScenarios().filter((s) => SWEEP[s.config.id]?.includes(s.route.id) && (!filter || new RegExp(filter).test(s.id)));
  console.log(`[sweep] ${scenarios.length} scénarios × ${WEIGHTS.length} poids (+ 3.5 historique, + exact ≤ ${exactMaxKm} km vol d'oiseau)`);

  for (const [index, scenario] of scenarios.entries()) {
    if (entries[scenario.id]?.points.length) continue;
    const itinerary = buildItinerary(app, scenario.config);
    const resolved = await app.resolveItineraryRouting(itinerary);
    const costScale = scaleOf(scenario.config.id);
    const entry: SweepEntry = {
      id: scenario.id,
      configId: scenario.config.id,
      routeId: scenario.route.id,
      band: scenario.band,
      beelineKm: Math.round(scenario.beelineKm),
      profileId: resolved.profileId,
      costScale: Math.round(costScale * 100) / 100,
      points: [],
    };
    const legacy = await route(upstream, scenario, resolved.profileId, 3.5, -1, null);
    entry.points.push(legacy);
    for (const weight of WEIGHTS) {
      const point = await route(upstream, scenario, resolved.profileId, Math.round(costScale * weight * 100) / 100, -1, weight);
      entry.points.push(point);
      if (!point.ok || point.ms > PRUNE_MS) break;
    }
    if (scenario.beelineKm <= exactMaxKm) {
      entry.points.push(await route(upstream, scenario, resolved.profileId, Math.round(costScale * 1.5 * 100) / 100, 0, null));
    }
    entries[scenario.id] = entry;
    try {
      fs.writeFileSync(`${outFile}.tmp`, JSON.stringify(entries, null, 1));
      fs.renameSync(`${outFile}.tmp`, outFile);
    } catch (error) {
      console.warn(`[sweep] écriture différée : ${(error as Error).message}`);
    }
    const best = Math.min(...entry.points.filter((p) => p.ok).map((p) => p.cost!));
    console.log(
      `${String(index + 1).padStart(3)}/${scenarios.length} ${scenario.id.padEnd(44)} s=${costScale.toFixed(2)} `
      + entry.points.map((p) => `${p.exact ? 'exact' : p.weight ?? '3.5'}:${p.ok ? `${(((p.cost! - best) / best) * 100).toFixed(1)}%/${(p.ms / 1000).toFixed(1)}s` : 'ERR'}`).join('  '),
    );
  }
  shim.restore();
  await closeLoader();
}

main().catch(async (error) => {
  console.error(error);
  await closeLoader();
  process.exit(1);
});
