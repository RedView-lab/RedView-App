import type { BrouterRoute } from '../types';

export const WATCHDOG_RETRY_DELAYS_MS = [250, 700, 1500];

export function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function isWatchdogMessage(message: string): boolean {
  return /thread-priority-watchdog/i.test(message);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function isExpectedDetourCandidateFailure(error: Error): boolean {
  return /via\d+-position not mapped|error re-tracking track/i.test(error.message);
}

export function computeClimbEfficiency(
  route: BrouterRoute,
  baseline: BrouterRoute,
): { addedDistanceKm: number; addedAscentM: number; gainPerAddedKm: number } {
  const addedDistanceKm = (route.distanceM - baseline.distanceM) / 1000;
  const addedAscentM = route.ascentM - baseline.ascentM;
  const gainPerAddedKm = addedAscentM / Math.max(0.5, addedDistanceKm);
  return { addedDistanceKm, addedAscentM, gainPerAddedKm };
}

export function scoreMinDistanceMaxAscent(route: BrouterRoute, baseline: BrouterRoute): number {
  const distanceKm = route.distanceM / 1000;
  const baseDistanceKm = baseline.distanceM / 1000;
  const addedDistanceKm = Math.max(0, distanceKm - baseDistanceKm);
  const addedAscentM = Math.max(0, route.ascentM - baseline.ascentM);
  const gainPerAddedKm = addedAscentM / Math.max(2.2, addedDistanceKm);
  const climbDensity = route.ascentM / Math.max(1, distanceKm);
  const softBudgetKm = Math.max(7, baseDistanceKm * 0.08);
  const overBudgetKm = Math.max(0, addedDistanceKm - softBudgetKm);
  return (
    gainPerAddedKm * 6400
    + addedAscentM * 7
    + climbDensity * 220
    - addedDistanceKm * 120
    - overBudgetKm * overBudgetKm * 320
  );
}
