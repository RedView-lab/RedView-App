/**
 * R4 / S2 / S13 — Préréglages de niveau du moteur v2.
 *
 *   npx tsx script-test-bench/pace-accuracy/presets-check.ts [--pkg=<dir>]
 *
 * - chaque niveau × genre sur les 6 jours de Jo (mode A) ;
 * - GT20 (593 km, ~10 000 m D+) en temps de déplacement, bandes provisoires ;
 * - vitesse sur 100 km de plat, VAM sur un col type (Alpe d'Huez simplifiée).
 * Ancrages : intermédiaire ♀ = Jo à ±5 % ; intermédiaire (défaut) au plus 5 %
 * plus rapide ; débutant nettement plus lent ; ordre monotone.
 */
import fs from 'node:fs';
import { loadPkg, predictV2, trackToV2Route, type V2Route } from './lib/engine';
import { compare, pct } from './lib/metrics';
import { formatHms, loadRides } from './lib/rides';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const LEVELS = ['debutant', 'intermediaire', 'avance', 'expert'] as const;
const GENDERS = ['female', 'unspecified'] as const;
/** Bandes GT20 provisoires (h de déplacement) — à valider avec Victor. */
const GT20_BANDS: Record<string, [number, number]> = {
  debutant: [42, 50],
  intermediaire: [33, 38],
  avance: [27, 31],
  expert: [22, 25],
};

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

function synthetic(lenM: number, eleAt: (d: number) => number): V2Route {
  const n = Math.round(lenM / 10) + 1;
  const ky = 111_194.93;
  return {
    lat: Float64Array.from({ length: n }, (_, i) => 45 + (i * 10) / ky),
    lon: new Float64Array(n).fill(6),
    ele: Float64Array.from({ length: n }, (_, i) => eleAt(i * 10)),
    dist: new Float64Array(0), surface: new Uint8Array(n).fill(1), way: new Uint8Array(0), wind: new Float64Array(0),
  };
}

async function main() {
  const glue = await loadPkg(arg('pkg'));
  const params = arg('params') ? JSON.parse(arg('params')!) : undefined;
  const rides = loadRides();
  const gt20 = gpxRoute('C:/Users/simon/Downloads/GT20.gpx');
  const flat = synthetic(100_000, () => 100);
  // Col type : 13,8 km à 8,1 % (Alpe d'Huez, profil lissé).
  const col = synthetic(13_800, (d) => 720 + 0.081 * d);

  const realTotal = rides.reduce((s, r) => s + r.movingTimeS, 0);
  console.log('niveau          genre        J1      J2     J3a     J3b      J4      J5   voyage   GT20 (bande)        plat km/h  col');
  const tripErr: Record<string, number> = {};
  for (const level of LEVELS) {
    for (const gender of GENDERS) {
      const rider = { preset: { level, gender } };
      const cfg = (geometry: string) => ({ rider, geometry, model_params: params });
      const errs = rides.map((r) => compare(r.track, predictV2(glue, trackToV2Route(r.track), cfg('gps'))));
      const trip = errs.reduce((s, c) => s + c.predS, 0) / realTotal * 100 - 100;
      tripErr[`${level}:${gender}`] = trip;
      const g = predictV2(glue, gt20, cfg('auto'));
      const f = predictV2(glue, flat, cfg('planned'));
      const c = predictV2(glue, col, cfg('planned'));
      const [lo, hi] = GT20_BANDS[level]!;
      const gh = g.total_time_s / 3600;
      console.log(
        `${level.padEnd(15)} ${gender.padEnd(11)} ${errs.map((e) => pct(e.errPct, 0).padStart(6)).join(' ')}  ${pct(trip).padStart(7)}  `
        + `${formatHms(g.total_time_s).padStart(6)} ${gh >= lo && gh <= hi ? 'OK ' : '!! '}(${lo}-${hi} h)  `
        + `${(100 / (f.total_time_s / 3600)).toFixed(1).padStart(8)}  ${formatHms(c.total_time_s)} ${Math.round((13_800 * 0.081) / (c.total_time_s / 3600))} m/h`,
      );
    }
  }
  console.log(`\nGT20 : ${(gt20.lat.length)} points, D+ ${Math.round(predictV2(glue, gt20, { rider: { preset: { level: 'intermediaire', gender: 'female' } } }).elevation_gain_m)} m`);
  const jo = tripErr['intermediaire:female']!;
  const def = tripErr['intermediaire:unspecified']!;
  const deb = tripErr['debutant:female']!;
  console.log(`Ancrages : intermédiaire ♀ ${pct(jo)} (±5 %), défaut ${pct(def)} (entre −5 % et 0), débutant ♀ ${pct(deb)} (+15 à +20 %)`);
}

main().catch((e) => { console.error(e); process.exit(2); });
