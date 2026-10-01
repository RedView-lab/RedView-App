/**
 * R11 — Ligne de base : précision du moteur figé (.baseline-pkg, moteur v1) ou
 * de n'importe quel pkg (PACE_PKG) sur les sorties réelles, via l'API
 * historique predict(fits, gpx, config) et les vrais builders TS.
 *
 *   npx tsx script-test-bench/pace-accuracy/baseline.ts [--pkg=<dir>]
 *
 * Mode A : la route est la trace FIT en mouvement (altitude baro).
 */
import { BASELINE_PKG, loadPkg, predictLegacy, trackToRoutePoints, type Gender, type PresetLevel, type RiderSpec } from './lib/engine';
import { compare, pct, type Comparison } from './lib/metrics';
import { formatHms, loadRides } from './lib/rides';

const pkgArg = process.argv.find((a) => a.startsWith('--pkg='))?.slice(6);
const LEVELS: PresetLevel[] = ['debutant', 'intermediaire', 'avance', 'expert'];

async function main() {
  const glue = await loadPkg(pkgArg ?? process.env.PACE_PKG ?? BASELINE_PKG);
  const rides = loadRides();

  const header = ['sortie', 'réel', 'LOO', 'in-sample', ...LEVELS.flatMap((l) => [`${l.slice(0, 5)}`, `${l.slice(0, 5)}♀`])];
  console.log(header.map((h, i) => (i === 0 ? h.padEnd(6) : h.padStart(9))).join(' '));

  const sums: Record<string, number[]> = {};
  const details: { ride: string; spec: string; c: Comparison }[] = [];
  const push = (key: string, v: number) => { (sums[key] ??= []).push(v); };

  for (const ride of rides) {
    const points = trackToRoutePoints(ride.track);
    const others = rides.filter((r) => r.id !== ride.id).map((r) => r.bytes);
    const specs: [string, RiderSpec][] = [
      ['LOO', { kind: 'custom', fits: others }],
      ['in-sample', { kind: 'custom', fits: rides.map((r) => r.bytes) }],
      ...LEVELS.flatMap((level) => (['default', 'female'] as Gender[]).map((gender) => [
        `${level}${gender === 'female' ? '♀' : ''}`,
        { kind: 'preset', level, gender } as RiderSpec,
      ] as [string, RiderSpec])),
    ];
    const cells: string[] = [];
    for (const [key, spec] of specs) {
      const pred = await predictLegacy(glue, points, spec);
      const c = compare(ride.track, pred);
      details.push({ ride: ride.id, spec: key, c });
      push(key, c.errPct);
      cells.push(pct(c.errPct).padStart(9));
    }
    console.log(`${ride.id.padEnd(6)} ${formatHms(ride.movingTimeS).padStart(9)} ${cells.join(' ')}`);
  }
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const meanAbs = (a: number[]) => a.reduce((s, v) => s + Math.abs(v), 0) / a.length;
  console.log(`${'biais'.padEnd(6)} ${''.padStart(9)} ${Object.values(sums).map((a) => pct(mean(a)).padStart(9)).join(' ')}`);
  console.log(`${'|err|'.padEnd(6)} ${''.padStart(9)} ${Object.values(sums).map((a) => pct(meanAbs(a)).padStart(9)).join(' ')}`);

  for (const key of ['LOO', 'intermediaire♀']) {
    console.log(`\nErreur de temps par classe de pente — ${key} (toutes sorties)`);
    const rows = details.filter((d) => d.spec === key);
    const labels = rows[0]!.c.byGrade.map((g) => g.label);
    console.log(['classe', 'km', 'réel', 'prédit', 'erreur'].map((h, i) => (i === 0 ? h.padEnd(8) : h.padStart(9))).join(' '));
    for (const label of labels) {
      let km = 0, real = 0, predS = 0;
      for (const r of rows) {
        const g = r.c.byGrade.find((x) => x.label === label)!;
        km += g.km; real += g.realS; predS += g.predS;
      }
      if (km < 0.5) continue;
      console.log(`${label.padEnd(8)} ${km.toFixed(1).padStart(9)} ${formatHms(real).padStart(9)} ${formatHms(predS).padStart(9)} ${pct(real > 0 ? ((predS - real) / real) * 100 : 0).padStart(9)}`);
    }
    const mapes = rows.map((r) => r.c.kmMapePct);
    console.log(`MAPE par km : ${mean(mapes).toFixed(1)}% ; 1re heure : ${pct(mean(rows.map((r) => r.c.firstHourErrPct)))} ; reste : ${pct(mean(rows.map((r) => r.c.restErrPct)))}`);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
