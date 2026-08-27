import type { PredictionPoint, PredictionResult } from '@/features/fitPredictor';
import type { StartReference } from './TimelineTimelineView/types';

export const DASH = '—';

export function fmtDistanceKm(km: number | null | undefined): string {
  if (km == null || !Number.isFinite(km)) return DASH;
  if (km === 0) return '0';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export function fmtSeconds(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return DASH;
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  if (m > 0) return `${m}min${sec > 0 ? String(sec).padStart(2, '0') : ''}`;
  return `${sec}s`;
}

export function fmtClock(elapsedS: number | null, reference: StartReference): string {
  if (elapsedS == null || !Number.isFinite(elapsedS)) return DASH;
  if (!reference.reference) {
    const totalMin = Math.round(elapsedS / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `+${h}h${String(m).padStart(2, '0')}`;
  }
  const date = new Date(reference.reference.getTime() + elapsedS * 1000);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function fmtSpeed(kmh: number | null | undefined): string {
  if (kmh == null || !Number.isFinite(kmh) || kmh <= 0) return DASH;
  return `${kmh.toFixed(1)} km/h`;
}

export function fmtPower(w: number | null | undefined): string {
  if (w == null || !Number.isFinite(w) || w <= 0) return DASH;
  return `${Math.round(w)} W`;
}

export function fmtElevation(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return DASH;
  return `${Math.round(m)} m`;
}

/** Binary-search the nearest prediction point + linear interpolation. */
export function pointAtDistanceM(
  prediction: PredictionResult | null | undefined,
  distanceM: number | null,
): PredictionPoint | null {
  if (prediction == null || distanceM == null || !Number.isFinite(distanceM)) return null;
  const pts = prediction.points;
  if (!pts || pts.length === 0) return null;
  if (distanceM <= pts[0]!.distance_m) return pts[0]!;
  if (distanceM >= pts[pts.length - 1]!.distance_m) return pts[pts.length - 1]!;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.distance_m <= distanceM) lo = mid;
    else hi = mid;
  }
  const a = pts[lo]!;
  const b = pts[hi]!;
  const span = b.distance_m - a.distance_m;
  if (span <= 0) return a;
  const t = (distanceM - a.distance_m) / span;
  return {
    distance_m: distanceM,
    elevation_m: a.elevation_m + (b.elevation_m - a.elevation_m) * t,
    gradient_pct: a.gradient_pct + (b.gradient_pct - a.gradient_pct) * t,
    predicted_speed_kmh: a.predicted_speed_kmh + (b.predicted_speed_kmh - a.predicted_speed_kmh) * t,
    predicted_power_w: a.predicted_power_w + (b.predicted_power_w - a.predicted_power_w) * t,
    elapsed_time_s: a.elapsed_time_s + (b.elapsed_time_s - a.elapsed_time_s) * t,
    segment_time_s: a.segment_time_s,
  };
}

/** Cumulative elevation gain / loss between two distances along the prediction. */
export function gainLossBetween(
  prediction: PredictionResult | null | undefined,
  fromM: number | null,
  toM: number | null,
): { gain: number; loss: number } | null {
  if (prediction == null || fromM == null || toM == null) return null;
  const pts = prediction.points;
  if (!pts || pts.length < 2) return null;
  const minM = Math.min(fromM, toM);
  const maxM = Math.max(fromM, toM);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < pts.length; i++) {
    const pPrev = pts[i - 1]!;
    const pCurr = pts[i]!;
    if (pCurr.distance_m < minM || pPrev.distance_m > maxM) continue;
    const diff = pCurr.elevation_m - pPrev.elevation_m;
    if (diff > 0) gain += diff;
    else loss += Math.abs(diff);
  }
  return { gain, loss };
}

export function avgSpeedBetween(
  prediction: PredictionResult | null | undefined,
  fromM: number | null,
  toM: number | null,
): number | null {
  if (prediction == null || fromM == null || toM == null) return null;
  const pA = pointAtDistanceM(prediction, Math.min(fromM, toM));
  const pB = pointAtDistanceM(prediction, Math.max(fromM, toM));
  if (!pA || !pB) return null;
  const dtS = pB.elapsed_time_s - pA.elapsed_time_s;
  const dxM = pB.distance_m - pA.distance_m;
  if (dtS <= 0 || dxM <= 0) return null;
  return (dxM / dtS) * 3.6;
}

export function avgPowerBetween(
  prediction: PredictionResult | null | undefined,
  fromM: number | null,
  toM: number | null,
): number | null {
  if (prediction == null || fromM == null || toM == null) return null;
  const pts = prediction.points;
  if (!pts || pts.length < 2) return null;
  const minM = Math.min(fromM, toM);
  const maxM = Math.max(fromM, toM);
  let workJ = 0;
  let dtTotalS = 0;
  for (let i = 1; i < pts.length; i++) {
    const pPrev = pts[i - 1]!;
    const pCurr = pts[i]!;
    if (pCurr.distance_m < minM || pPrev.distance_m > maxM) continue;
    const dt = pCurr.elapsed_time_s - pPrev.elapsed_time_s;
    const pAvg = (pPrev.predicted_power_w + pCurr.predicted_power_w) / 2;
    if (dt > 0) {
      workJ += pAvg * dt;
      dtTotalS += dt;
    }
  }
  return dtTotalS > 0 ? workJ / dtTotalS : null;
}
