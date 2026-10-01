/**
 * GT20 (593 km, ~9 800 m D+) d'une traite : préréglages et calibrations .fit
 * (Jo, Victor), sur le GPX brut et sur le tracé tel que l'app l'envoie au
 * moteur (altitudes IGN RGE ALTI ré-échantillonnées à l'import, nettoyées,
 * revêtement asphalte). Les altitudes IGN sont mises en cache (réseau).
 *
 *   npx tsx script-test-bench/pace-accuracy/gt20-probe.ts [--pkg=<dir>] [--params=<json>] [--over=<json>]
 *     [--who=Jo,Jo ♀,Victor] [--no-fit]
 */
import fs from 'node:fs';
import path from 'node:path';
import { cleanAndInterpolateElevations } from '../../src/features/itineraryPanel/lib/route-metrics/elevationSanitizer.ts';
import { computeRouteElevationMetrics } from '../../src/features/itineraryPanel/lib/route-metrics/metrics.ts';
import { loadPkg, predictV2, silenceConsole, type V2Route } from './lib/engine';
import { formatHms, haversineM, loadRides, loadRidesFromDir } from './lib/rides';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const CACHE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '.cache');
const GT20 = process.env.PACE_GT20 ?? 'C:/Users/simon/Downloads/GT20.gpx';
const VICTOR_DIR = process.env.PACE_VICTOR_DIR ?? 'C:/Users/simon/Downloads/victorfit';

function gpxRoute(file: string): V2Route {
  const text = fs.readFileSync(file, 'utf8');
  const lat: number[] = [], lon: number[] = [], ele: number[] = [];
  for (const m of text.matchAll(/<(trkpt|rtept)\s+([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g)) {
    const la = /lat="([-\d.eE]+)"/.exec(m[2]!);
    const lo = /lon="([-\d.eE]+)"/.exec(m[2]!);
    if (!la || !lo) continue;
    const e = m[4] ? /<ele>([-\d.eE]+)<\/ele>/.exec(m[4]) : null;
    lat.push(Number(la[1])); lon.push(Number(lo[1])); ele.push(e ? Number(e[1]) : NaN);
  }
  return { lat: Float64Array.from(lat), lon: Float64Array.from(lon), ele: Float64Array.from(ele), dist: new Float64Array(0), surface: new Uint8Array(0), way: new Uint8Array(0), wind: new Float64Array(0) };
}

/** Altitudes IGN RGE ALTI aux points du tracé (même service que l'app), en cache. */
async function ignElevations(r: V2Route): Promise<number[]> {
  const file = path.join(CACHE, 'gt20-ign.json');
  if (fs.existsSync(file)) {
    const cached: number[] = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached.length === r.lat.length) return cached;
  }
  const out: number[] = [];
  const batch = 4000;
  for (let i = 0; i < r.lat.length; i += batch) {
    const res = await fetch('https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lon: Array.from(r.lon.subarray(i, i + batch), (v) => v.toFixed(6)).join('|'),
        lat: Array.from(r.lat.subarray(i, i + batch), (v) => v.toFixed(6)).join('|'),
        resource: 'ign_rge_alti_wld', delimiter: '|', indent: 'false', measures: 'false', zonly: 'true',
      }),
    });
    const ele = (await res.json()).elevations;
    if (!Array.isArray(ele)) throw new Error(`IGN : réponse invalide (${res.status})`);
    out.push(...ele);
    await new Promise((done) => setTimeout(done, 300));
  }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

/** Comme l'import de l'app : altitudes IGN, nettoyage, axe de distance, asphalte. */
function appRoute(raw: V2Route, ign: number[]): V2Route {
  let d = 0;
  const pts = Array.from(raw.lat, (la, i) => {
    if (i > 0) d += haversineM(raw.lat[i - 1]!, raw.lon[i - 1]!, la, raw.lon[i]!);
    return { lat: la, lon: raw.lon[i]!, distanceM: d, elevationM: ign[i]! > -500 ? ign[i]! : null };
  });
  const clean = cleanAndInterpolateElevations(pts);
  console.log(`tracé app : D+ affiché ${Math.round(computeRouteElevationMetrics(clean)?.ascentM ?? NaN)} m`);
  return {
    lat: raw.lat,
    lon: raw.lon,
    ele: Float64Array.from(clean, (p) => (Number.isFinite(p.elevationM as number) ? (p.elevationM as number) : NaN)),
    dist: Float64Array.from(clean, (p) => p.distanceM as number),
    surface: new Uint8Array(raw.lat.length).fill(1 | (1 << 4)),
    way: new Uint8Array(raw.lat.length),
    wind: new Float64Array(0),
  };
}

async function main() {
  const glue = await loadPkg(arg('pkg'));
  const params = arg('params') ? JSON.parse(arg('params')!) : undefined;
  const over = arg('over') ? JSON.parse(arg('over')!) : undefined;
  const raw = gpxRoute(GT20);
  const app = appRoute(raw, await ignElevations(raw));
  const run = (route: V2Route, rider: unknown) => predictV2(glue, route, { rider, geometry: 'auto', model_params: params });
  const show = (name: string, rider: unknown) => {
    const a = run(raw, rider), b = run(app, rider);
    console.log(`${name.padEnd(26)} GPX brut ${formatHms(a.total_time_s).padStart(7)}   tracé app ${formatHms(b.total_time_s).padStart(7)}  (D+ moteur ${Math.round(a.elevation_gain_m)} / ${Math.round(b.elevation_gain_m)})`);
  };
  for (const level of ['debutant', 'intermediaire', 'avance', 'expert']) {
    show(`${level} (défaut)`, { preset: { level, gender: 'unspecified' } });
  }
  show('intermediaire (femme)', { preset: { level: 'intermediaire', gender: 'female' } });
  if (process.argv.includes('--no-fit')) return;
  const who = (arg('who') ?? 'Jo,Victor').split(',');
  const sets = [['Jo', () => loadRides(), 'unspecified'], ['Jo ♀', () => loadRides(), 'female'], ['Victor', () => loadRidesFromDir(VICTOR_DIR, 'V'), 'unspecified']] as const;
  for (const [name, load, gender] of sets.filter(([n]) => who.includes(n))) {
    const rides = load();
    const cal = silenceConsole(() => glue.calibrate_cycling(rides.map((r) => r.bytes), { rider: { custom: { gender } }, model_params: params, rider_override: over }, () => {}));
    const m = cal.model;
    console.log(`${name} : P plat ${m.p_flat_w.toFixed(0)} W, montée ×${m.climb_ratio.toFixed(2)}, descente ≤ ${m.desc_vmax_kmh.toFixed(0)} km/h, multiplicateurs ${cal.report.multipliers.map((x: number) => x.toFixed(2)).join('/')}, validation ${cal.report.loo_median_abs_pct} % ; sorties ${cal.report.rides.map((r: any) => `${r.moving_h.toFixed(1)} h : ${r.error_pct} % (LOO ${r.loo_error_pct})`).join(' · ')}`);
    show(`  ${name} calibré`, { model: m });
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
