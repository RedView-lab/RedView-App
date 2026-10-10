import type { PredictionPoint, PredictionResult } from '@/features/fitPredictor';
import type { SportDiscipline } from '@/shared/lib/discipline';
import { translateAppText } from '@/shared/i18n/config';
import { formatSpeedOrPace, kmhToPaceSecPerKm } from '@/shared/lib/pace';
import type { StartReference } from './TimelineTimelineView/types';
import { formatDayLabel } from './TimelineTimelineView/utils';

const DASH = '—';

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

const MS_PER_DAY = 86_400_000;

function calendarDayOffset(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((end - start) / MS_PER_DAY);
}

/**
 * Heure de passage (`scheduledS` : secondes depuis le départ, pauses
 * comprises) : « 14:05 » le jour du départ, puis précédée du jour — « Dim
 * 07:40 » avec une date de départ, « J2 07:40 » sans. Sur un ultra de
 * plusieurs jours, une heure seule ne dit pas quand on passe.
 */
export function fmtClock(scheduledS: number | null, reference: StartReference): string {
  if (scheduledS == null || !Number.isFinite(scheduledS)) return DASH;
  if (!reference.reference) {
    const totalMin = Math.round(scheduledS / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `+${h}h${String(m).padStart(2, '0')}`;
  }
  const date = new Date(reference.reference.getTime() + scheduledS * 1000);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const dayOffset = calendarDayOffset(reference.reference, date);
  if (dayOffset <= 0) return time;
  return reference.hasRealDate
    ? `${formatDayLabel(date)} ${time}`
    : translateAppText('J{{day}} {{time}}', { day: dayOffset + 1, time });
}

/** Clé de tri d'une cellule de vitesse : la vitesse à vélo, l'allure (s/km) en trail / course. */
export function speedSortKey(kmh: number | null, discipline: SportDiscipline): number | null {
  if (kmh == null) return null;
  return discipline === 'bike' ? kmh : kmhToPaceSecPerKm(kmh);
}

/** km/h à vélo, min/km en trail / course. */
export function fmtSpeedOrPace(kmh: number | null | undefined, discipline: SportDiscipline): string {
  if (kmh == null || !Number.isFinite(kmh) || kmh <= 0) return DASH;
  return formatSpeedOrPace(kmh, discipline);
}

export function fmtPower(w: number | null | undefined): string {
  if (w == null || !Number.isFinite(w) || w <= 0) return DASH;
  return `${Math.round(w)} W`;
}

export function fmtElevation(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return DASH;
  return `${Math.round(m)} m`;
}

export function fmtTemperature(c: number | null | undefined): string {
  if (c == null || !Number.isFinite(c)) return DASH;
  return `${Math.round(c)}°C`;
}

export function fmtRain(mm: number | null | undefined): string {
  if (mm == null || !Number.isFinite(mm)) return DASH;
  return `${mm.toFixed(1)} mm`;
}

export function fmtWind(kmh: number | null | undefined): string {
  if (kmh == null || !Number.isFinite(kmh)) return DASH;
  return `${Math.round(kmh)} km/h`;
}

export function fmtCloudCover(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return DASH;
  return `${Math.round(pct)}%`;
}

/** Recherche dichotomique du point de prédiction le plus proche + interpolation linéaire. */
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

/** Dénivelé positif / négatif cumulé entre deux distances le long de la prédiction. */
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
