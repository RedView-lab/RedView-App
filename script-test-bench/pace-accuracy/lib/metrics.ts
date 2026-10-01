/**
 * Comparaison prédiction / réel le long d'une sortie.
 *
 * Les deux axes de distance (trace FIT haversine, moteur après son propre
 * nettoyage) diffèrent de quelques pour mille : on compare donc à fraction de
 * distance égale.
 */
import { realTimeAt, type TrackPoint } from './rides';
import type { PredictionLike } from './engine';

export interface Comparison {
  realS: number;
  predS: number;
  errPct: number;
  /** Erreur absolue moyenne (%) des temps par bloc de 1 km. */
  kmMapePct: number;
  /** Par classe de pente (pente réelle baro lissée, blocs de 100 m). */
  byGrade: { label: string; km: number; realS: number; predS: number; errPct: number }[];
  /** Première heure réelle vs reste. */
  firstHourErrPct: number;
  restErrPct: number;
}

export const GRADE_CLASSES: { label: string; min: number; max: number }[] = [
  { label: '<-8', min: -Infinity, max: -8 },
  { label: '-8..-5', min: -8, max: -5 },
  { label: '-5..-3', min: -5, max: -3 },
  { label: '-3..-1', min: -3, max: -1 },
  { label: '-1..1', min: -1, max: 1 },
  { label: '1..3', min: 1, max: 3 },
  { label: '3..5', min: 3, max: 5 },
  { label: '5..7', min: 5, max: 7 },
  { label: '>7', min: 7, max: Infinity },
];

/** Temps prédit cumulé à la fraction f de la distance totale prédite. */
export function predTimeAtFraction(pred: PredictionLike, f: number): number {
  const pts = pred.points;
  const total = pred.total_distance_m;
  const d = f * total;
  if (pts.length === 0) return 0;
  if (d <= pts[0]!.distance_m) return pts[0]!.elapsed_time_s;
  const last = pts[pts.length - 1]!;
  if (d >= last.distance_m) return pred.total_time_s;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.distance_m <= d) lo = mid;
    else hi = mid;
  }
  const a = pts[lo]!;
  const b = pts[hi]!;
  const span = b.distance_m - a.distance_m;
  return span > 0 ? a.elapsed_time_s + (b.elapsed_time_s - a.elapsed_time_s) * ((d - a.distance_m) / span) : a.elapsed_time_s;
}

/** Altitude baro lissée (moyenne glissante ±halfM) aux distances demandées. */
export function smoothedEleAt(track: TrackPoint[], ds: number[], halfM = 50): number[] {
  const out: number[] = [];
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (const d of ds) {
    while (hi < track.length && track[hi]!.d <= d + halfM) { sum += track[hi]!.ele; hi++; }
    while (lo < hi && track[lo]!.d < d - halfM) { sum -= track[lo]!.ele; lo++; }
    out.push(hi > lo ? sum / (hi - lo) : track[Math.min(lo, track.length - 1)]!.ele);
  }
  return out;
}

export function compare(track: TrackPoint[], pred: PredictionLike): Comparison {
  const total = track[track.length - 1]!.d;
  const realS = track[track.length - 1]!.t;
  const predS = pred.total_time_s;
  const predAt = (d: number) => predTimeAtFraction(pred, d / total);

  // Blocs de 1 km
  let mape = 0;
  let nKm = 0;
  for (let d0 = 0; d0 + 1000 <= total; d0 += 1000) {
    const r = realTimeAt(track, d0 + 1000) - realTimeAt(track, d0);
    const p = predAt(d0 + 1000) - predAt(d0);
    if (r > 0) { mape += Math.abs(p - r) / r; nKm++; }
  }

  // Par classe de pente (blocs de 100 m)
  const step = 100;
  const edges: number[] = [];
  for (let d = 0; d <= total; d += step) edges.push(d);
  const eles = smoothedEleAt(track, edges);
  const acc = GRADE_CLASSES.map((c) => ({ label: c.label, km: 0, realS: 0, predS: 0, errPct: 0 }));
  for (let i = 0; i + 1 < edges.length; i++) {
    const g = ((eles[i + 1]! - eles[i]!) / step) * 100;
    const k = GRADE_CLASSES.findIndex((c) => g >= c.min && g < c.max);
    const a = acc[k]!;
    a.km += step / 1000;
    a.realS += realTimeAt(track, edges[i + 1]!) - realTimeAt(track, edges[i]!);
    a.predS += predAt(edges[i + 1]!) - predAt(edges[i]!);
  }
  for (const a of acc) a.errPct = a.realS > 0 ? ((a.predS - a.realS) / a.realS) * 100 : 0;

  // Première heure
  let dHour = total;
  for (const p of track) { if (p.t >= 3600) { dHour = p.d; break; } }
  const rH = realTimeAt(track, dHour);
  const pH = predAt(dHour);
  return {
    realS,
    predS,
    errPct: ((predS - realS) / realS) * 100,
    kmMapePct: nKm > 0 ? (mape / nKm) * 100 : 0,
    byGrade: acc,
    firstHourErrPct: rH > 0 ? ((pH - rH) / rH) * 100 : 0,
    restErrPct: realS - rH > 0 ? ((predS - pH - (realS - rH)) / (realS - rH)) * 100 : 0,
  };
}

export function pct(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}
