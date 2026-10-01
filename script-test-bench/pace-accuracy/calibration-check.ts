/**
 * R1 / R2 / R3 — Calibration .fit du moteur v2, mesurée contre la vérité TS
 * (indépendante du parseur Rust) en mode A (trace FIT, altitude baro).
 *
 *   npx tsx script-test-bench/pace-accuracy/calibration-check.ts [--pkg=<dir>] [--gender=female|unspecified]
 *
 * R1 : chaque sortie prédite par un modèle calibré sur les 5 autres.
 * R2 : jours alpins (J1, J2) → plaine (J3a…J5) et l'inverse.
 * R3 : calibré sur les 6 (plafond de ce que le modèle peut faire).
 */
import { loadPkg, predictV2, silenceConsole, trackToV2Route } from './lib/engine';
import { compare, pct } from './lib/metrics';
import { formatHms, loadRides, type Ride } from './lib/rides';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const glue = await loadPkg(arg('pkg'));
  const gender = arg('gender') ?? 'female';
  const prior = { custom: { gender } };
  const rides = loadRides();

  const calibrate = (train: Ride[]) => {
    const t0 = performance.now();
    const res = silenceConsole(() => glue.calibrate_cycling(train.map((r) => r.bytes), { rider: prior }, () => {}));
    return { res, ms: performance.now() - t0 };
  };
  const predictWith = (ride: Ride, model: unknown) =>
    compare(ride.track, predictV2(glue, trackToV2Route(ride.track), { rider: { model }, geometry: 'gps' }));

  const summary = (label: string, errs: number[]) => {
    const abs = errs.map(Math.abs).sort((a, b) => a - b);
    const median = abs[Math.floor((abs.length - 1) / 2)]! / 2 + abs[Math.ceil((abs.length - 1) / 2)]! / 2;
    console.log(`${label}: biais ${pct(errs.reduce((s, v) => s + v, 0) / errs.length)}  |err| médiane ${median.toFixed(1)}%  max ${abs[abs.length - 1]!.toFixed(1)}%`);
    return { median, max: abs[abs.length - 1]! };
  };

  // R3 — tout
  const full = calibrate(rides);
  const rep = full.res.report;
  console.log(`Calibration sur 6 sorties : ${full.ms.toFixed(0)} ms, multiplicateurs ${rep.multipliers.map((m: number) => m.toFixed(3)).join(' / ')}, a_lat ${full.res.model.a_lat_ms2.toFixed(2)} (mesuré ${rep.a_lat_measured?.toFixed(2) ?? '-'} sur ${rep.a_lat_samples} apex)`);
  console.log(`Rapport moteur : LOO médiane ${rep.loo_median_abs_pct}% max ${rep.loo_max_abs_pct}%, précision attendue ±${rep.expected_accuracy_pct}%, avertissements [${rep.warnings.join(', ')}]`);
  console.log('Table de vitesses (observé / modèle) :');
  for (const row of rep.grade_table) console.log(`   ${row.label.padEnd(7)} ${String(row.km).padStart(6)} km  ${row.real_kmh.toFixed(1).padStart(5)} / ${row.model_kmh.toFixed(1).padStart(5)} km/h`);

  console.log('\nsortie   réel     R3 in-sample   R1 LOO (TS)   LOO (moteur)');
  const r1: number[] = [];
  const r3: number[] = [];
  for (const [i, ride] of rides.entries()) {
    const c3 = predictWith(ride, full.res.model);
    r3.push(c3.errPct);
    const loo = calibrate(rides.filter((r) => r.id !== ride.id));
    const c1 = predictWith(ride, loo.res.model);
    r1.push(c1.errPct);
    console.log(`${ride.id.padEnd(6)} ${formatHms(ride.movingTimeS).padStart(7)}   ${pct(c3.errPct).padStart(8)}       ${pct(c1.errPct).padStart(8)}       ${pct(rep.rides[i].loo_error_pct ?? NaN).padStart(8)}   (${loo.ms.toFixed(0)} ms)`);
  }
  const s3 = summary('R3 in-sample', r3);
  const s1 = summary('R1 LOO', r1);

  // R2 — croisé chronologique
  const alps = rides.filter((r) => r.id === 'D1' || r.id === 'D2');
  const plains = rides.filter((r) => !(r.id === 'D1' || r.id === 'D2'));
  const r2: number[] = [];
  const fromAlps = calibrate(alps).res.model;
  for (const ride of plains) r2.push(predictWith(ride, fromAlps).errPct);
  const fromPlains = calibrate(plains).res.model;
  for (const ride of alps) r2.push(predictWith(ride, fromPlains).errPct);
  console.log(`R2 alpes→plaine : ${plains.map((r, i) => `${r.id} ${pct(r2[i]!)}`).join('  ')}`);
  console.log(`R2 plaine→alpes : ${alps.map((r, i) => `${r.id} ${pct(r2[plains.length + i]!)}`).join('  ')}`);
  const s2 = summary('R2 croisé', r2);

  // Voyage complet (somme des temps)
  const real = rides.reduce((s, r) => s + r.movingTimeS, 0);
  const predTot = rides.reduce((s, r, i) => s + r.movingTimeS * (1 + r1[i]! / 100), 0);
  const trip = (predTot / real - 1) * 100;
  console.log(`Voyage complet (prédictions LOO) : ${formatHms(predTot)} pour ${formatHms(real)} réel → ${pct(trip)}`);

  const gates = [
    ['R1 LOO médiane ≤ 5 %', s1.median <= 5],
    ['R1 LOO max ≤ 8 %', s1.max <= 8],
    ['R2 croisé max ≤ 7 %', s2.max <= 7],
    ['Voyage complet ≤ 3 %', Math.abs(trip) <= 3],
    ['R3 in-sample médiane ≤ 5 %', s3.median <= 5],
  ] as const;
  console.log('\n' + gates.map(([l, ok]) => `${ok ? 'OK  ' : 'ÉCHEC'} ${l}`).join('\n'));
  process.exit(gates.every(([, ok]) => ok) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
