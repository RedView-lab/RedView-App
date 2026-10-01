/**
 * Forme de la fatigue au fil d'un ultra : chaque sortie est prédite par un
 * modèle calibré sur les autres (LOO), et on compare la vitesse prédite et
 * réelle par tranche de temps de roulage réel. Une erreur qui dérive dans le
 * temps (trop lent au début, trop rapide à la fin) = loi de fatigue mal formée.
 *   npx tsx script-test-bench/pace-accuracy/decay-check-dir.ts <dossier> [--slice=6] [--params=<json>] [--pkg=<dir>]
 */
import { loadPkg, predictV2, silenceConsole, trackToV2Route } from './lib/engine';
import { loadRidesFromDir } from './lib/rides';

const dir = process.argv[2];
if (!dir) throw new Error('usage');
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sliceH = Number(arg('slice') ?? 6);
const params = arg('params') ? JSON.parse(arg('params')!) : undefined;
const over = arg('over') ? JSON.parse(arg('over')!) : undefined;

async function main() {
  const glue = await loadPkg(arg('pkg'));
  const rides = loadRidesFromDir(dir, 'V');
  const agg: { real: number; pred: number }[] = [];
  for (const ride of rides) {
    const train = rides.filter((r) => r.id !== ride.id);
    const cal = silenceConsole(() => glue.calibrate_cycling(train.map((r) => r.bytes), { rider: { custom: { gender: 'unspecified' } }, model_params: params, rider_override: over }, () => {}));
    const res = predictV2(glue, trackToV2Route(ride.track), { rider: { model: cal.model }, geometry: 'gps', model_params: params });
    const pts = res.points as { distance_m: number; elapsed_time_s: number }[];
    const predAt = (d: number) => {
      let lo = 0, hi = pts.length - 1;
      if (d <= pts[0]!.distance_m) return pts[0]!.elapsed_time_s;
      if (d >= pts[hi]!.distance_m) return pts[hi]!.elapsed_time_s;
      while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (pts[m]!.distance_m <= d) lo = m; else hi = m; }
      const a = pts[lo]!, b = pts[hi]!;
      return a.elapsed_time_s + (b.elapsed_time_s - a.elapsed_time_s) * (d - a.distance_m) / Math.max(1e-6, b.distance_m - a.distance_m);
    };
    // Tranches par temps réel : distance réelle aux bornes.
    const cells: string[] = [];
    let k = 0;
    for (let t0 = 0; t0 < ride.movingTimeS - 1800; t0 += sliceH * 3600, k++) {
      const t1 = Math.min(ride.movingTimeS, t0 + sliceH * 3600);
      const d0 = ride.track.find((p) => p.t >= t0)?.d ?? 0;
      const d1 = ride.track.find((p) => p.t >= t1)?.d ?? ride.distanceM;
      const real = t1 - t0, pred = predAt(d1) - predAt(d0);
      agg[k] ??= { real: 0, pred: 0 };
      agg[k]!.real += real; agg[k]!.pred += pred;
      cells.push(`${((pred / real - 1) * 100).toFixed(0).padStart(4)}`);
    }
    console.log(`${ride.label.slice(0, 28).padEnd(28)} total ${((res.total_time_s / ride.movingTimeS - 1) * 100).toFixed(1).padStart(6)} %  par ${sliceH} h :${cells.join('')}`);
  }
  console.log(`${'cumul (pondéré)'.padEnd(28)} ${' '.repeat(16)}par ${sliceH} h :${agg.map((a) => ((a.pred / a.real - 1) * 100).toFixed(0).padStart(4)).join('')}`);
}
main().catch((e) => { console.error(e); process.exit(2); });
