import type { PlatformProfile } from '../../src/features/lidar/viewer/lod/types.ts';
import { AdaptivePointBudget } from '../../src/features/lidar/viewer/lod/lodBudget.ts';
import { FrameClock } from '../../src/features/lidar/viewer/perf/frameClock.ts';
import { check, createRandom } from './harness.ts';

// ---------------------------------------------------------------------------
// 9–10. Cadence réelle et budget de points
// ---------------------------------------------------------------------------

export function runFrameClockCheck(): void {
  const rand = createRandom(99);
  const cases = [60, 120, 144].map((hz) => {
    const clock = new FrameClock();
    const period = 1000 / hz;
    let now = 0;
    for (let i = 0; i < 400; i++) {
      // 30 % des images ratent une ou deux synchronisations verticales, avec un peu de gigue de minuteur.
      const vsyncs = rand() < 0.3 ? (rand() < 0.5 ? 2 : 3) : 1;
      now += vsyncs * period + (rand() - 0.5) * 0.4;
      clock.frame(now);
    }
    return { hz, refresh: clock.getRefreshMs(), target: clock.getTargetIntervalMs(), period };
  });
  const slow = new FrameClock();
  for (let i = 0; i < 400; i++) slow.frame(i * (1000 / 30));
  const detected = cases.every((c) => Math.abs(c.refresh - c.period) < 0.05);
  const targets = cases.map((c) => `${c.hz} Hz → ${(1000 / c.target).toFixed(0)} fps visés`).join(', ');
  check(
    "Cadence réelle : période d'écran retrouvée malgré les vsync ratées",
    detected && Math.abs(slow.getRefreshMs() - 1000 / 60) < 0.05,
    'fps affichés = 1000 / coût GPU de la frame (50 fps affichés pour 25 réels)',
    `${cases.map((c) => `${c.hz} Hz lu ${(1000 / c.refresh).toFixed(1)} Hz`).join(', ')} · ${targets} · GPU à 30 fps lu ${(1000 / slow.getRefreshMs()).toFixed(0)} Hz`,
  );
}

const BUDGET_PROFILE: PlatformProfile = {
  tier: 'integrated', minBudget: 400_000, initialBudget: 1_500_000, maxBudget: 6_000_000, restMaxBudget: 20_000_000, poolBudget: 24_000_000,
  maxCanvasDim: 4096, dprCap: 1.25, isApple: false, motionScale: 0.7,
};

/**
 * Pilote le budget avec un GPU modélisé à 60 Hz : `gpuMs(points)` pour les
 * passes de dessin, plus `overheadMs` que les horodatages ne voient pas
 * (compositeur, flou des panneaux). Une image tombe sur la synchronisation
 * verticale qui suit les deux.
 */
function simulateBudget(gpuMs: (points: number) => number, overheadMs: number, frames: number, rest = false) {
  const budget = new AdaptivePointBudget(BUDGET_PROFILE, { preciseGpu: true });
  const period = 1000 / 60;
  const missed: boolean[] = [];
  const budgets: number[] = [];
  for (let i = 0; i < frames; i++) {
    const gpu = gpuMs(budget.pointBudget);
    const vsyncs = Math.max(1, Math.ceil((gpu + overheadMs) / period - 1e-9));
    budget.sample({ gpuMs: gpu, cpuMs: 1, intervalMs: vsyncs * period, targetIntervalMs: period, refreshMs: period, rest });
    missed.push(vsyncs > 1);
    budgets.push(budget.pointBudget);
  }
  const tail = (values: number[]) => values.slice(-600);
  const tailMissed = tail(missed.map(Number));
  return {
    missedRatio: tailMissed.reduce((sum, value) => sum + value, 0) / tailMissed.length,
    minBudget: Math.min(...tail(budgets)),
    maxBudget: Math.max(...tail(budgets)),
    finalBudget: budget.pointBudget,
  };
}

/**
 * L'ancien contrôleur (avant celui à cadence réelle), même modèle de GPU : une
 * cible fixe de 16,6 ms sur le coût mesuré, qui diminue au-dessus de 19,1 ms et
 * augmente sous 12,5 ms, aveugle à la synchronisation verticale.
 */
function simulateLegacyBudget(gpuMs: (points: number) => number, overheadMs: number, frames: number) {
  const target = 16.6;
  const period = 1000 / 60;
  let budget = BUDGET_PROFILE.initialBudget;
  let avg = target;
  let slow = 0;
  let fast = 0;
  let missed = 0;
  for (let i = 0; i < frames; i++) {
    const gpu = gpuMs(budget);
    if (i >= frames - 600 && gpu + overheadMs > period) missed++;
    avg += (Math.min(gpu, target * 4) - avg) / 8;
    if (i < 8) continue;
    if (avg > target * 1.15) {
      fast = 0;
      if (++slow >= 6) { budget = Math.max(BUDGET_PROFILE.minBudget, Math.floor(budget * 0.9)); slow = 0; }
    } else if (avg < target * 0.75) {
      slow = 0;
      if (++fast >= 12) { budget = Math.min(BUDGET_PROFILE.maxBudget, Math.floor(budget * 1.15)); fast = 0; }
    } else {
      slow = 0;
      fast = 0;
    }
  }
  return { missedRatio: missed / 600, finalBudget: budget };
}

export function runBudgetCheck(): void {
  // GPU linéaire, 5 ms que les horodatages ne voient pas : les images ratent la synchronisation au-delà de ~2,9 M points.
  const linear = (points: number) => 3 + points * 3e-6;
  const overheadMs = 5;
  const limited = simulateBudget(linear, overheadMs, 3000);
  const legacy = simulateLegacyBudget(linear, overheadMs, 3000);
  const limitPoints = (1000 / 60 - 3 - overheadMs) / 3e-6;
  // DVFS : le GPU baisse sa fréquence, donc la durée de sa passe reste ~11 ms quelle que soit la charge.
  const dvfs = simulateBudget(() => 11, 3, 3000);
  // Les images fixes en pleine résolution coûtent 1,5× l'intervalle : elles ne doivent pas réduire le budget en mouvement.
  const rest = simulateBudget(() => 25, 3, 600, true);
  check(
    'Budget de points : calé sur la cadence réelle, pas sur 16,6 ms de GPU',
    limited.missedRatio < 0.1 && limited.minBudget > limitPoints * 0.7 && limited.maxBudget < limitPoints * 1.15
      && dvfs.finalBudget === BUDGET_PROFILE.maxBudget && dvfs.missedRatio === 0
      && rest.finalBudget === BUDGET_PROFILE.initialBudget,
    `cible 16,6 ms de GPU (bande 12,5–19 ms), sans voir la vsync : budget ${(legacy.finalBudget / 1e6).toFixed(2)} M, ${(legacy.missedRatio * 100).toFixed(0)} % de frames ratées (≈ 30 fps réels)`,
    `limite ${(limitPoints / 1e6).toFixed(2)} M pts : budget ${(limited.minBudget / 1e6).toFixed(2)}–${(limited.maxBudget / 1e6).toFixed(2)} M, ${(limited.missedRatio * 100).toFixed(1)} % ratées · GPU à fréquence variable : ${(dvfs.finalBudget / 1e6).toFixed(1)} M (plafond) · arrêt : budget inchangé`,
  );
}
