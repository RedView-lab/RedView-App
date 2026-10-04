import type { PredictionResult } from '@/features/fitPredictor';

/**
 * Temps de roulage prédit à une distance du tracé, partagé par la timeline, le
 * flyover et le graphique d'analyse. Module feuille (aucun import d'exécution) :
 * la timeline l'importe sans dépendre du flyover.
 */

export function clampDistanceM(distanceM: number, totalDistanceM: number): number {
  if (!Number.isFinite(distanceM)) return 0;
  return Math.max(0, Math.min(totalDistanceM, distanceM));
}

export function elapsedSecondsAtDistance(
  prediction: PredictionResult | null | undefined,
  distanceM: number,
  totalDistanceM: number,
): number | null {
  const points = prediction?.points ?? [];
  if (points.length >= 2) {
    if (distanceM <= points[0].distance_m) return points[0].elapsed_time_s;
    const lastPoint = points[points.length - 1];
    if (distanceM >= lastPoint.distance_m) return lastPoint.elapsed_time_s;

    let lo = 0;
    let hi = points.length - 1;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (points[mid].distance_m <= distanceM) lo = mid;
      else hi = mid;
    }

    const start = points[lo];
    const end = points[hi];
    const span = end.distance_m - start.distance_m;
    if (span <= 0) return start.elapsed_time_s;
    const t = (distanceM - start.distance_m) / span;
    return start.elapsed_time_s + (end.elapsed_time_s - start.elapsed_time_s) * t;
  }

  const totalTimeS = prediction?.total_time_s ?? null;
  if (!Number.isFinite(totalTimeS) || !Number.isFinite(totalDistanceM) || totalDistanceM <= 0) {
    return null;
  }
  return (clampDistanceM(distanceM, totalDistanceM) / totalDistanceM) * (totalTimeS as number);
}
