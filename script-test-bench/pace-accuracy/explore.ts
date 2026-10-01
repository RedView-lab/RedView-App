/**
 * Exploration du moteur v2 sur les sorties réelles (mode A : trace FIT, alt. baro).
 *
 *   npx tsx script-test-bench/pace-accuracy/explore.ts [--rider=<json>] [--override=<json>] [--params=<json>] [--pkg=<dir>]
 *
 * Défaut : préréglage intermédiaire, genre femme (l'ancre du banc).
 */
import { loadPkg, predictV2, trackToV2Route } from './lib/engine';
import { compare, pct } from './lib/metrics';
import { formatHms, loadRides } from './lib/rides';
import { headwindAlongRide } from './lib/wind';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const glue = await loadPkg(arg('pkg'));
  const rider = arg('rider') ? JSON.parse(arg('rider')!) : { preset: { level: 'intermediaire', gender: 'female' } };
  const config: Record<string, unknown> = {
    rider,
    geometry: 'gps',
    output: { diagnostics: true },
  };
  if (arg('override')) config.rider_override = JSON.parse(arg('override')!);
  if (arg('params')) config.model_params = JSON.parse(arg('params')!);

  const rides = loadRides();
  const agg = new Map<string, { km: number; realS: number; predS: number }>();
  const errs: number[] = [];
  console.log('sortie   réel     prédit   erreur  MAPEkm  1reH    virages  phys    marche  ms');
  for (const ride of rides) {
    const wind = process.argv.includes('--wind') ? await headwindAlongRide(ride) : undefined;
    if (wind) {
      const mean = wind.reduce((s, v) => s + v, 0) / wind.length;
      console.log(`   ${ride.id} vent de face moyen ${mean.toFixed(2)} m/s`);
    }
    const t0 = performance.now();
    const pred = predictV2(glue, trackToV2Route(ride.track, { wind }), config);
    const ms = performance.now() - t0;
    const c = compare(ride.track, pred);
    errs.push(c.errPct);
    const tb = pred.time_breakdown;
    console.log(
      `${ride.id.padEnd(6)} ${formatHms(c.realS).padStart(7)} ${formatHms(c.predS).padStart(8)} ${pct(c.errPct).padStart(8)} `
      + `${c.kmMapePct.toFixed(1).padStart(6)}% ${pct(c.firstHourErrPct).padStart(7)} ${(tb.corner_loss_s / 60).toFixed(1).padStart(6)}mn `
      + `${(tb.physio_loss_s / 60).toFixed(1).padStart(5)}mn ${(tb.walk_m / 1000).toFixed(2).padStart(5)}km ${ms.toFixed(0).padStart(5)}`,
    );
    for (const g of c.byGrade) {
      const a = agg.get(g.label) ?? { km: 0, realS: 0, predS: 0 };
      a.km += g.km; a.realS += g.realS; a.predS += g.predS;
      agg.set(g.label, a);
    }
  }
  const mean = errs.reduce((s, v) => s + v, 0) / errs.length;
  const mae = errs.reduce((s, v) => s + Math.abs(v), 0) / errs.length;
  console.log(`biais ${pct(mean)}  |err| moyen ${mae.toFixed(1)}%  max ${Math.max(...errs.map(Math.abs)).toFixed(1)}%`);
  console.log('\nclasse     km     réel km/h  prédit km/h  erreur temps');
  for (const [label, a] of agg) {
    if (a.km < 0.5) continue;
    console.log(`${label.padEnd(8)} ${a.km.toFixed(1).padStart(6)} ${(a.km / (a.realS / 3600)).toFixed(1).padStart(10)} ${(a.km / (a.predS / 3600)).toFixed(1).padStart(12)} ${pct(((a.predS - a.realS) / a.realS) * 100).padStart(12)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
