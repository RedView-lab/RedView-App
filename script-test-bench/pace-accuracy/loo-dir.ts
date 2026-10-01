/**
 * Validation « N−1 sorties → la dernière » sur un dossier de .fit quelconque.
 *
 *   npx tsx script-test-bench/pace-accuracy/loo-dir.ts <dossier> [--gender=unspecified|female|male] [--no-old]
 *
 * Pour chaque sortie : calibration du moteur v2 sur les autres, prédiction sur
 * la trace réelle (altitude baro), comparée au temps de roulage réel (arrêts
 * exclus). Références : préréglages avancé / expert, et ancien moteur
 * (`.baseline-pkg`, mêmes .fit d'entraînement).
 */
import { BASELINE_PKG, loadPkg, predictLegacy, predictV2, silenceConsole, trackToRoutePoints, trackToV2Route } from './lib/engine';
import { smoothedEleAt } from './lib/metrics';
import { formatHms, loadRidesFromDir, type Ride } from './lib/rides';

const dir = process.argv[2];
if (!dir) throw new Error('usage: loo-dir.ts <dossier>');
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const gender = arg('gender') ?? 'unspecified';
const withOld = !process.argv.includes('--no-old');

const delta = (pred: number, real: number) => {
  const min = Math.round((pred - real) / 60);
  const pct = ((pred - real) / real) * 100;
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  return `${min >= 0 ? '+' : '−'}${h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)} %)`;
};

function dplusOf(r: Ride): number {
  const edges: number[] = [];
  for (let d = 0; d <= r.distanceM; d += 100) edges.push(d);
  const ele = smoothedEleAt(r.track, edges, 50);
  let s = 0;
  for (let i = 1; i < ele.length; i++) s += Math.max(0, ele[i]! - ele[i - 1]!);
  return s;
}

async function main() {
  const glue = await loadPkg(arg('pkg'));
  const old = withOld ? await loadPkg(BASELINE_PKG) : null;
  const rides = loadRidesFromDir(dir, 'V');
  const rows: string[] = [];
  const err = { v2: [] as number[], expert: [] as number[], avance: [] as number[], old: [] as number[] };
  const tot = { real: 0, v2: 0, expert: 0, avance: 0, old: 0 };

  for (const ride of rides) {
    const train = rides.filter((r) => r.id !== ride.id);
    const t0 = performance.now();
    const cal = silenceConsole(() => glue.calibrate_cycling(train.map((r) => r.bytes), { rider: { custom: { gender } } }, () => {}));
    const calS = (performance.now() - t0) / 1000;
    const route = trackToV2Route(ride.track);
    const v2 = predictV2(glue, route, { rider: { model: cal.model }, geometry: 'gps' });
    const expert = predictV2(glue, route, { rider: { preset: { level: 'expert', gender } }, geometry: 'gps' });
    const avance = predictV2(glue, route, { rider: { preset: { level: 'avance', gender } }, geometry: 'gps' });
    let oldT = NaN;
    if (old) {
      try {
        oldT = (await predictLegacy(old, trackToRoutePoints(ride.track), { kind: 'custom', fits: train.map((r) => r.bytes) })).total_time_s;
      } catch (e) {
        console.error(`ancien moteur en échec sur ${ride.label} : ${String(e).slice(0, 120)}`);
      }
    }
    const real = ride.movingTimeS;
    const stops = ride.pauses.reduce((s, p) => s + p.durationS, 0);
    err.v2.push((v2.total_time_s - real) / real * 100);
    err.expert.push((expert.total_time_s - real) / real * 100);
    err.avance.push((avance.total_time_s - real) / real * 100);
    if (Number.isFinite(oldT)) err.old.push((oldT - real) / real * 100);
    tot.real += real; tot.v2 += v2.total_time_s; tot.expert += expert.total_time_s; tot.avance += avance.total_time_s; tot.old += oldT;
    const m = cal.model;
    console.error(`${ride.label} : calibration ${calS.toFixed(1)} s sur ${train.length} sorties (P plat ${m.p_flat_w.toFixed(0)} W, montée ×${m.climb_ratio.toFixed(2)}, descente ≤ ${m.desc_vmax_kmh.toFixed(0)} km/h, a_lat ${m.a_lat_ms2.toFixed(2)} ; validation interne ${cal.report.loo_median_abs_pct} %)`);
    rows.push(`| ${ride.label} | ${(ride.distanceM / 1000).toFixed(0)} km · ${Math.round(dplusOf(ride))} m | **${formatHms(real)}** (arrêts ${formatHms(stops)}) | ${formatHms(v2.total_time_s)} | ${delta(v2.total_time_s, real)} | ${formatHms(expert.total_time_s)} | ${delta(expert.total_time_s, real)} | ${formatHms(avance.total_time_s)} | ${delta(avance.total_time_s, real)} | ${Number.isFinite(oldT) ? `${formatHms(oldT)} | ${delta(oldT, real)}` : '— | —'} |`);
  }

  const meanAbs = (v: number[]) => v.reduce((s, x) => s + Math.abs(x), 0) / Math.max(1, v.length);
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
  console.log('| Course prédite (calibré sur les 4 autres) | Distance · D+ | Roulage réel | Nouveau moteur | Écart | Préréglage expert | Écart | Préréglage avancé | Écart | Ancien moteur | Écart |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r) => console.log(r));
  console.log(`| **Total** | — | **${formatHms(tot.real)}** | ${formatHms(tot.v2)} | ${delta(tot.v2, tot.real)} | ${formatHms(tot.expert)} | ${delta(tot.expert, tot.real)} | ${formatHms(tot.avance)} | ${delta(tot.avance, tot.real)} | ${Number.isFinite(tot.old) ? `${formatHms(tot.old)} | ${delta(tot.old, tot.real)}` : '— | —'} |`);
  console.log(`\nÉcart moyen absolu : nouveau moteur ${meanAbs(err.v2).toFixed(1)} % (biais ${mean(err.v2).toFixed(1)} %) · expert ${meanAbs(err.expert).toFixed(1)} % (biais ${mean(err.expert).toFixed(1)} %) · avancé ${meanAbs(err.avance).toFixed(1)} % (biais ${mean(err.avance).toFixed(1)} %) · ancien ${meanAbs(err.old).toFixed(1)} % (biais ${mean(err.old).toFixed(1)} %)`);
}

main().catch((e) => { console.error(e); process.exit(2); });
