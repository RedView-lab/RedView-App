/**
 * R10 — Vérité terrain : moving time par sortie et sensibilité à sa définition.
 *
 *   npx tsx script-test-bench/pace-accuracy/truth-check.ts
 */
import { RIDES, extractRide, formatHms } from './lib/rides';

const thresholds = [0.3, 0.6, 1.0];
console.log('sortie  km      D+baro  moving(0.3/0.6/1.0 m/s)        timer   écart%  pauses≥1min  dist. trous');
for (const meta of RIDES) {
  const rides = thresholds.map((v) => extractRide(meta, { minMovingSpeedMs: v }));
  const ref = rides[1]!;
  let dplus = 0;
  // D+ indicatif sur l'altitude baro lissée (±50 m) — même ordre que l'analyse initiale.
  const tr = ref.track;
  let prevEle: number | null = null;
  for (let i = 0; i < tr.length; i++) {
    let sum = 0, n = 0;
    for (let j = i; j >= 0 && tr[i]!.d - tr[j]!.d <= 50; j--) { sum += tr[j]!.ele; n++; }
    for (let j = i + 1; j < tr.length && tr[j]!.d - tr[i]!.d <= 50; j++) { sum += tr[j]!.ele; n++; }
    const e = sum / n;
    if (prevEle != null && e > prevEle) dplus += e - prevEle;
    prevEle = e;
  }
  const spread = (Math.max(...rides.map((r) => r.movingTimeS)) - Math.min(...rides.map((r) => r.movingTimeS))) / ref.movingTimeS * 100;
  console.log(
    `${ref.id.padEnd(6)}  ${(ref.distanceM / 1000).toFixed(1).padStart(6)}  ${dplus.toFixed(0).padStart(6)}  `
    + `${rides.map((r) => formatHms(r.movingTimeS)).join(' / ').padEnd(28)}  ${ref.timerS ? formatHms(ref.timerS) : '  -  '}  `
    + `${spread.toFixed(1).padStart(5)}  ${String(ref.pauses.length).padStart(4)} (${formatHms(ref.pauses.reduce((s, p) => s + p.durationS, 0))})  `
    + `${(ref.gapDistanceM / 1000).toFixed(2)} km  pts=${ref.track.length}`,
  );
}
