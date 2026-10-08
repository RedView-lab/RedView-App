/**
 * Réalisme du moteur v2 face à des références publiques (web) et au profil de Jo.
 *
 *   npx tsx script-test-bench/pace-accuracy/realism.ts [--pkg=<dir>] [--params=<json>]
 *
 * Géométrie réelle des cols via BRouter (proxy public de l'app, mis en cache),
 * profils : préréglages de niveau (♂ / ♀) et modèle calibré sur les 6 .fit de Jo.
 * Les références viennent de sources publiques (moyennes Strava, guides) : ce
 * sont des ordres de grandeur, pas des vérités terrain.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GT20_GPX } from '../core/data-paths.ts';
import { loadPkg, predictV2, silenceConsole, trackToV2Route, type V2Route } from './lib/engine';
import { formatHms, haversineM, loadRides } from './lib/rides';
import { straight } from './lib/synthetic';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const CACHE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '.cache');
const ENDPOINT = process.env.PACE_BROUTER ?? 'https://app.redview.tech/api/brouter';

interface Climb {
  id: string;
  label: string;
  from: [number, number];
  to: [number, number];
  via?: [number, number][];
  /** Profil BRouter : la voiture suit les routes classiques des cols. */
  profiles: string[];
  refKm: number;
  refDplus: number;
}

const CLIMBS: Climb[] = [
  { id: 'alpe-car', label: "Alpe d'Huez (Bourg-d'Oisans)", from: [45.0555, 6.0300], to: [45.0915, 6.0700], profiles: ['car-fast', 'car-eco'], refKm: 13.8, refDplus: 1071 },
  { id: 'ventoux', label: 'Mont Ventoux (Bédoin)', from: [44.1245, 5.1797], to: [44.1741, 5.2787], profiles: ['fastbike'], refKm: 21.5, refDplus: 1610 },
  { id: 'galibier', label: 'Galibier (Valloire)', from: [45.1650, 6.4290], to: [45.0640, 6.4080], profiles: ['fastbike'], refKm: 18.0, refDplus: 1245 },
  { id: 'tourmalet-car', label: 'Tourmalet (Luz-Saint-Sauveur)', from: [42.8722, -0.0034], to: [42.9089, 0.1452], profiles: ['car-fast', 'car-eco'], refKm: 19.0, refDplus: 1404 },
];

let lastFetch = 0;
async function brouter(c: Climb): Promise<V2Route> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `climb-${c.id}.json`);
  let coords: [number, number, number][];
  if (fs.existsSync(file)) {
    coords = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    const pts = [c.from, ...(c.via ?? []), c.to];
    const lonlats = pts.map(([la, lo]) => `${lo},${la}`).join('|');
    for (const profile of c.profiles) {
      const wait = lastFetch + 3300 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastFetch = Date.now();
      const res = await fetch(`${ENDPOINT}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`);
      if (!res.ok) continue;
      const json = await res.json();
      coords = json.features?.[0]?.geometry?.coordinates;
      if (coords?.length) break;
    }
    if (!coords!) throw new Error(`BRouter: pas de route pour ${c.id}`);
    fs.writeFileSync(file, JSON.stringify(coords));
  }
  return {
    lat: Float64Array.from(coords, (p) => p[1]), lon: Float64Array.from(coords, (p) => p[0]), ele: Float64Array.from(coords, (p) => p[2]),
    dist: new Float64Array(0), surface: new Uint8Array(0), way: new Uint8Array(0), wind: new Float64Array(0),
  };
}

/** Altitudes IGN RGE ALTI (comme l'app en France) à la place du SRTM de BRouter. */
async function withIgnElevation(c: Climb, r: V2Route): Promise<V2Route> {
  const file = path.join(CACHE, `climb-${c.id}-ign.json`);
  let ele: number[];
  if (fs.existsSync(file)) {
    ele = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    const res = await fetch('https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lon: Array.from(r.lon, (v) => v.toFixed(6)).join('|'),
        lat: Array.from(r.lat, (v) => v.toFixed(6)).join('|'),
        resource: 'ign_rge_alti_wld', delimiter: '|', indent: 'false', measures: 'false', zonly: 'true',
      }),
    });
    ele = (await res.json()).elevations;
    if (!Array.isArray(ele) || ele.length !== r.lat.length) throw new Error(`IGN: réponse invalide pour ${c.id}`);
    fs.writeFileSync(file, JSON.stringify(ele));
  }
  return { ...r, ele: Float64Array.from(ele, (v) => (v > -500 ? v : NaN)) };
}

function maxGrade(r: V2Route, windowM: number): number {
  const d: number[] = [0];
  for (let i = 1; i < r.lat.length; i++) d.push(d[i - 1]! + haversineM(r.lat[i - 1]!, r.lon[i - 1]!, r.lat[i]!, r.lon[i]!));
  let best = 0;
  let j = 0;
  for (let i = 0; i < d.length; i++) {
    while (j < d.length - 1 && d[j]! - d[i]! < windowM) j++;
    if (d[j]! - d[i]! >= windowM * 0.9) best = Math.max(best, ((r.ele[j]! - r.ele[i]!) / (d[j]! - d[i]!)) * 100);
  }
  return best;
}

function reverse(r: V2Route): V2Route {
  return { ...r, lat: r.lat.slice().reverse(), lon: r.lon.slice().reverse(), ele: r.ele.slice().reverse() };
}

function gpx(file: string): V2Route {
  const text = fs.readFileSync(file, 'utf8');
  const lat: number[] = [], lon: number[] = [], ele: number[] = [];
  for (const m of text.matchAll(/<(trkpt|rtept)\s+([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g)) {
    const la = /lat="([-\d.eE]+)"/.exec(m[2]!); const lo = /lon="([-\d.eE]+)"/.exec(m[2]!);
    if (!la || !lo) continue;
    const e = m[4] ? /<ele>([-\d.eE]+)<\/ele>/.exec(m[4]) : null;
    lat.push(Number(la[1])); lon.push(Number(lo[1])); ele.push(e ? Number(e[1]) : NaN);
  }
  return { lat: Float64Array.from(lat), lon: Float64Array.from(lon), ele: Float64Array.from(ele), dist: new Float64Array(0), surface: new Uint8Array(0), way: new Uint8Array(0), wind: new Float64Array(0) };
}

async function main() {
  const glue = await loadPkg(arg('pkg'));
  const params = arg('params') ? JSON.parse(arg('params')!) : undefined;
  const rides = loadRides();
  const jo = silenceConsole(() => glue.calibrate_cycling(rides.map((r) => r.bytes), { rider: { custom: { gender: 'female' } } }, () => {})).model;
  const riders: [string, unknown][] = [
    ['débutant ♂', { preset: { level: 'debutant', gender: 'unspecified' } }],
    ['interm. ♂', { preset: { level: 'intermediaire', gender: 'unspecified' } }],
    ['avancé ♂', { preset: { level: 'avance', gender: 'unspecified' } }],
    ['expert ♂', { preset: { level: 'expert', gender: 'unspecified' } }],
    ['débutant ♀', { preset: { level: 'debutant', gender: 'female' } }],
    ['interm. ♀', { preset: { level: 'intermediaire', gender: 'female' } }],
    ['Jo (fit)', { model: jo }],
  ];
  const run = (route: V2Route, rider: unknown, geometry = 'planned') =>
    predictV2(glue, route, { rider, geometry, model_params: params, output: { diagnostics: true } });

  console.log(`Profil calibré de Jo : P plat ${jo.p_flat_w.toFixed(0)} W, montée ×${jo.climb_ratio.toFixed(2)}, masse ${jo.mass_kg} kg, CdA ${jo.cda}, confort descente ${jo.desc_v1_kmh.toFixed(1)}→${jo.desc_vmax_kmh.toFixed(1)} km/h, a_lat ${jo.a_lat_ms2.toFixed(2)}\n`);

  // ── Cols : montée et descente ──
  const useIgn = !process.argv.includes('--srtm');
  for (const c of CLIMBS) {
    const raw = await brouter(c);
    const up = useIgn ? await withIgnElevation(c, raw) : raw;
    console.log(`   (pente max sur 100 m / 300 m — SRTM : ${maxGrade(raw, 100).toFixed(1)} / ${maxGrade(raw, 300).toFixed(1)} %, ${useIgn ? `IGN : ${maxGrade(up, 100).toFixed(1)} / ${maxGrade(up, 300).toFixed(1)} %` : 'IGN non utilisé'})`);
    let len = 0;
    for (let i = 1; i < up.lat.length; i++) len += haversineM(up.lat[i - 1]!, up.lon[i - 1]!, up.lat[i]!, up.lon[i]!);
    const probe = run(up, riders[1]![1]);
    console.log(`${c.label} : BRouter ${(len / 1000).toFixed(1)} km, D+ ${Math.round(probe.elevation_gain_m)} m (référence ${c.refKm} km, ${c.refDplus} m), ${up.lat.length} points`);
    const down = reverse(up);
    for (const [name, rider] of riders) {
      const u = run(up, rider);
      const d = run(down, rider);
      const vam = probe.elevation_gain_m / (u.total_time_s / 3600);
      console.log(`   ${name.padEnd(11)} montée ${formatHms(u.total_time_s).padStart(5)} (${Math.round(vam)} m/h, ${(len / u.total_time_s * 3.6).toFixed(1)} km/h)   descente ${formatHms(d.total_time_s).padStart(5)} (${(len / d.total_time_s * 3.6).toFixed(1)} km/h, virages ${(d.time_breakdown.corner_loss_s / 60).toFixed(1)} min, marche ${u.time_breakdown.walk_m} m)`);
    }
  }

  // ── Plat ──
  const flat = straight(100_000, () => 100, { step: 50 });
  console.log('\n100 km de plat (sans vent) :');
  console.log('   ' + riders.map(([name, rider]) => `${name} ${(100 / (run(flat, rider).total_time_s / 3600)).toFixed(1)}`).join(' | ') + ' km/h');

  // ── GT20 ──
  const gt20 = gpx(GT20_GPX);
  const g0 = run(gt20, riders[1]![1], 'auto');
  console.log(`\nGT20 (${(g0.total_distance_m / 1000).toFixed(0)} km, D+ moteur ${Math.round(g0.elevation_gain_m)} m) — temps de déplacement d'une traite :`);
  console.log('   ' + riders.map(([name, rider]) => `${name} ${(run(gt20, rider, 'auto').total_time_s / 3600).toFixed(1)} h`).join(' | '));

  // ── Voyage de Jo d'une traite (le moteur ne connaît pas les nuits) ──
  const all = rides.flatMap((r) => r.track);
  let acc = 0;
  const joined = all.map((p, i) => { if (i > 0) acc += haversineM(all[i - 1]!.lat, all[i - 1]!.lon, p.lat, p.lon); return { ...p, d: acc }; });
  const real = rides.reduce((s, r) => s + r.movingTimeS, 0);
  const one = run(trackToV2Route(joined), { model: jo }, 'gps');
  const perDay = rides.reduce((s, r) => s + run(trackToV2Route(r.track), { model: jo }, 'gps').total_time_s, 0);
  console.log(`\nCham→Paris (724 km) avec le profil de Jo : réel ${formatHms(real)} | jour par jour ${formatHms(perDay)} (${((perDay / real - 1) * 100).toFixed(1)} %) | d'une traite ${formatHms(one.total_time_s)} (${((one.total_time_s / real - 1) * 100).toFixed(1)} %, perte physiologique ${(one.time_breakdown.physio_loss_s / 3600).toFixed(1)} h)`);
}

main().catch((e) => { console.error(e); process.exit(2); });
