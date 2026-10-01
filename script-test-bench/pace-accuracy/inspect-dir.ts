/**
 * Résumé des sorties .fit d'un dossier : distance, D+, durée totale, temps de
 * roulage, arrêts (dont nuits ≥ 2 h).
 *
 *   npx tsx script-test-bench/pace-accuracy/inspect-dir.ts <dossier>
 */
import { formatHms, loadRidesFromDir } from './lib/rides';
import { smoothedEleAt } from './lib/metrics';

const dir = process.argv[2];
if (!dir) throw new Error('usage: inspect-dir.ts <dossier>');
const t0 = performance.now();
const rides = loadRidesFromDir(dir, 'V');
console.log(`${rides.length} sorties décodées en ${((performance.now() - t0) / 1000).toFixed(1)} s\n`);
for (const r of rides) {
  const total = r.distanceM;
  const edges: number[] = [];
  for (let d = 0; d <= total; d += 100) edges.push(d);
  const ele = smoothedEleAt(r.track, edges, 50);
  let dplus = 0;
  for (let i = 1; i < ele.length; i++) dplus += Math.max(0, ele[i]! - ele[i - 1]!);
  const stops = r.pauses.reduce((s, p) => s + p.durationS, 0);
  const sleeps = r.pauses.filter((p) => p.durationS >= 7200);
  const start = new Date(r.startEpoch * 1000).toISOString().slice(0, 10);
  console.log(`${r.id} ${r.label} (${start})`);
  console.log(`   ${(total / 1000).toFixed(0)} km, D+ ≈ ${Math.round(dplus)} m, ${r.track.length} points, trous d'enregistrement ${(r.gapDistanceM / 1000).toFixed(1)} km`);
  console.log(`   durée totale ${formatHms(r.elapsedS)}, roulage ${formatHms(r.movingTimeS)} (${(total / 1000 / (r.movingTimeS / 3600)).toFixed(1)} km/h), arrêts ${formatHms(stops)} dont ${sleeps.length} de plus de 2 h (${formatHms(sleeps.reduce((s, p) => s + p.durationS, 0))})`);
}
