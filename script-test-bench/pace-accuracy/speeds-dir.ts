/**
 * Vitesses réelles par classe de pente, par sortie (blocs de 100 m, altitude
 * baro lissée, temps de roulage) + vitesse par tranche de 12 h de roulage.
 *
 *   npx tsx script-test-bench/pace-accuracy/speeds-dir.ts <dossier>
 */
import { smoothedEleAt } from './lib/metrics';
import { loadRidesFromDir, realTimeAt } from './lib/rides';

const dir = process.argv[2];
if (!dir) throw new Error('usage: speeds-dir.ts <dossier>');
const CLASSES: [string, number, number][] = [['<-6', -99, -6], ['-6..-3', -6, -3], ['-3..-1', -3, -1], ['-1..1', -1, 1], ['1..3', 1, 3], ['3..6', 3, 6], ['6..9', 6, 9], ['>9', 9, 99]];
const rides = loadRidesFromDir(dir, 'V');
console.log(`${'course'.padEnd(30)} ${CLASSES.map(([l]) => l.padStart(8)).join('')}   vitesse par tranche de 12 h de roulage`);
for (const r of rides) {
  const total = r.distanceM;
  const edges: number[] = [];
  for (let d = 0; d + 100 <= total; d += 100) edges.push(d);
  edges.push(edges[edges.length - 1]! + 100);
  const ele = smoothedEleAt(r.track, edges, 50);
  const acc = CLASSES.map(() => ({ km: 0, s: 0 }));
  for (let i = 0; i + 1 < edges.length; i++) {
    const g = ele[i + 1]! - ele[i]!;
    const k = CLASSES.findIndex(([, lo, hi]) => g >= lo && g < hi);
    const dt = realTimeAt(r.track, edges[i + 1]!) - realTimeAt(r.track, edges[i]!);
    if (k >= 0 && dt > 0 && dt < 600) { acc[k]!.km += 0.1; acc[k]!.s += dt; }
  }
  const cells = acc.map((a) => (a.km > 2 ? (a.km / (a.s / 3600)).toFixed(1) : '-').padStart(8)).join('');
  // Vitesse moyenne par tranche de 12 h de roulage.
  const slices: string[] = [];
  for (let h = 0; h * 12 * 3600 < r.movingTimeS; h++) {
    const t0 = h * 12 * 3600, t1 = Math.min(r.movingTimeS, (h + 1) * 12 * 3600);
    const d0 = r.track.find((p) => p.t >= t0)?.d ?? 0;
    const d1 = r.track.find((p) => p.t >= t1)?.d ?? total;
    slices.push(((d1 - d0) / 1000 / ((t1 - t0) / 3600)).toFixed(1));
  }
  console.log(`${r.label.slice(0, 30).padEnd(30)} ${cells}   ${slices.join(' ')}`);
}
