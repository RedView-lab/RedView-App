/**
 * Roadbook "Feuille de route" — column registry.
 *
 * Single source of truth for every column the user can toggle in the sheet
 * view. Each column knows how to:
 *   - render its header label (i18n keys);
 *   - compute its cell value from a `TimelineColumnContext` built once per row;
 *   - expose a numeric/string sort key for stable sortable ordering.
 *
 * Add a new column = add a new entry to `TIMELINE_COLUMNS`. The sheet view
 * picks it up automatically (header + cell + dropdown entry).
 */

import type { PredictionPoint, PredictionResult } from '@/features/fitPredictor';
import type { RhythmState, TimelineItem } from '../../types';
import type { StartReference } from './TimelineTimelineView/types';
import { elapsedSecondsAtDistance } from '@/features/centerPanel/flyover/playback';

// ─────────────────────────────────────────────────────────────────────────────
// Column identifiers (stable — persisted in user settings).
// ─────────────────────────────────────────────────────────────────────────────

export type TimelineColumnId =
  | 'typePicto'
  | 'typeText'
  | 'name'
  | 'distance'
  | 'clockTime'
  | 'elapsedTime'
  | 'segmentTimePrev'
  | 'segmentTimeNext'
  | 'avgSpeedFromStart'
  | 'avgSpeedSincePrev'
  | 'avgSpeedToNext'
  | 'avgPowerFromStart'
  | 'avgPowerSincePrev'
  | 'avgPowerToNext'
  | 'gainFromStart'
  | 'gainSincePrev'
  | 'gainToNext'
  | 'lossFromStart'
  | 'lossSincePrev'
  | 'lossToNext'
  | 'altitude'
  | 'wind'
  | 'temperature'
  | 'rain'
  | 'cloudCover';

export type TimelineColumnAlign = 'left' | 'right' | 'center';

export interface TimelineColumnContext {
  item: TimelineItem;
  /** Visible-previous item (skips hidden ones). */
  prevItem: TimelineItem | null;
  /** Visible-next item. */
  nextItem: TimelineItem | null;
  /** Distance of this row, in metres (resolved/clamped). */
  distanceM: number | null;
  prevDistanceM: number | null;
  nextDistanceM: number | null;
  /** Total ride distance in metres. */
  totalDistanceM: number;
  prediction: PredictionResult | null | undefined;
  rhythm: RhythmState | undefined;
  reference: StartReference;
  /** Elapsed seconds since departure at this row's distance. */
  elapsedS: number | null;
  elapsedPrevS: number | null;
  elapsedNextS: number | null;
  /** Cached interpolated prediction point at this row's distance. */
  point: PredictionPoint | null;
  pointPrev: PredictionPoint | null;
  pointNext: PredictionPoint | null;
}

export interface TimelineColumnCell {
  display: string;
  /**
   * Sort key — number when meaningful, string for text columns. `null` rows
   * are always pushed to the end regardless of direction.
   */
  sortKey: number | string | null;
}

export interface TimelineColumnDef {
  id: TimelineColumnId;
  /** i18n key — passed through `t()` at render time. */
  label: string;
  /** Short header label (when the full one would overflow the 64-px min). */
  shortLabel?: string;
  defaultOn: boolean;
  align: TimelineColumnAlign;
  /** Minimum width in pixels (>=64 per spec). */
  minWidth: number;
  /** When true, the column cannot be removed from the dropdown (always shown). */
  pinned?: boolean;
  /** When true, the column is rendered as a custom cell by the sheet view. */
  custom?: boolean;
  /** Pure data accessor — used for sortable columns. */
  getCell: (ctx: TimelineColumnContext) => TimelineColumnCell;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters.
// ─────────────────────────────────────────────────────────────────────────────

const DASH = '—';

function fmtDistanceKm(km: number | null | undefined): string {
  if (km == null || !Number.isFinite(km)) return DASH;
  if (km === 0) return '0';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

function fmtSeconds(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return DASH;
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  if (m > 0) return `${m}min${sec > 0 ? String(sec).padStart(2, '0') : ''}`;
  return `${sec}s`;
}

function fmtClock(elapsedS: number | null, reference: StartReference): string {
  if (elapsedS == null || !Number.isFinite(elapsedS)) return DASH;
  if (!reference.reference) {
    // Fall back to elapsed relative format when no start time is known.
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

function fmtSpeed(kmh: number | null | undefined): string {
  if (kmh == null || !Number.isFinite(kmh) || kmh <= 0) return DASH;
  return `${kmh.toFixed(1)} km/h`;
}

function fmtPower(w: number | null | undefined): string {
  if (w == null || !Number.isFinite(w) || w <= 0) return DASH;
  return `${Math.round(w)} W`;
}

function fmtElevation(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return DASH;
  return `${Math.round(m)} m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prediction helpers.
// ─────────────────────────────────────────────────────────────────────────────

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
  if (prediction == null) return null;
  const pts = prediction.points;
  if (!pts || pts.length < 2) return null;
  if (fromM == null || toM == null || !Number.isFinite(fromM) || !Number.isFinite(toM)) return null;
  if (toM <= fromM) return { gain: 0, loss: 0 };

  const fromElev = pointAtDistanceM(prediction, fromM)?.elevation_m;
  const toElev = pointAtDistanceM(prediction, toM)?.elevation_m;
  if (fromElev == null || toElev == null) return null;

  let gain = 0;
  let loss = 0;
  let prevElev = fromElev;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]!;
    if (p.distance_m <= fromM) continue;
    if (p.distance_m >= toM) break;
    const delta = p.elevation_m - prevElev;
    if (delta > 0) gain += delta;
    else loss -= delta;
    prevElev = p.elevation_m;
  }
  const finalDelta = toElev - prevElev;
  if (finalDelta > 0) gain += finalDelta;
  else loss -= finalDelta;
  return { gain, loss };
}

function avgPowerBetween(
  prediction: PredictionResult | null | undefined,
  fromM: number | null,
  toM: number | null,
): number | null {
  if (prediction == null) return null;
  const pts = prediction.points;
  if (!pts || pts.length < 2) return null;
  if (fromM == null || toM == null || !Number.isFinite(fromM) || !Number.isFinite(toM)) return null;
  if (toM <= fromM) return null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]!;
    if (p.distance_m < fromM) continue;
    if (p.distance_m > toM) break;
    if (Number.isFinite(p.predicted_power_w) && p.predicted_power_w > 0) {
      sum += p.predicted_power_w;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

function avgSpeedFromElapsed(
  distanceM: number | null,
  elapsedS: number | null,
): number | null {
  if (distanceM == null || elapsedS == null || elapsedS <= 0 || distanceM <= 0) return null;
  return (distanceM / 1000) / (elapsedS / 3600);
}

function avgSpeedBetween(
  fromM: number | null,
  toM: number | null,
  fromS: number | null,
  toS: number | null,
): number | null {
  if (fromM == null || toM == null || fromS == null || toS == null) return null;
  const dM = toM - fromM;
  const dS = toS - fromS;
  if (dM <= 0 || dS <= 0) return null;
  return (dM / 1000) / (dS / 3600);
}

// ─────────────────────────────────────────────────────────────────────────────
// Column registry.
// ─────────────────────────────────────────────────────────────────────────────

export const TIMELINE_COLUMNS: TimelineColumnDef[] = [
  {
    id: 'typePicto',
    label: 'Type (picto)',
    shortLabel: 'Type',
    defaultOn: true,
    align: 'center',
    minWidth: 64,
    custom: true,
    getCell: (ctx) => ({ display: '', sortKey: ctx.item.kind }),
  },
  {
    id: 'typeText',
    label: 'Type (texte)',
    shortLabel: 'Type',
    defaultOn: true,
    align: 'left',
    minWidth: 80,
    custom: true,
    getCell: (ctx) => ({ display: '', sortKey: ctx.item.kind }),
  },
  {
    id: 'name',
    label: 'Nom',
    defaultOn: true,
    align: 'left',
    minWidth: 160,
    pinned: true,
    custom: true,
    getCell: (ctx) => ({ display: ctx.item.label, sortKey: ctx.item.label.toLowerCase() }),
  },
  {
    id: 'distance',
    label: 'Distance',
    defaultOn: true,
    align: 'right',
    minWidth: 80,
    pinned: true,
    getCell: (ctx) => ({
      display: fmtDistanceKm(ctx.item.distanceKm),
      sortKey: ctx.item.distanceKm ?? null,
    }),
  },
  {
    id: 'clockTime',
    label: 'Heure de passage',
    shortLabel: 'Heure',
    defaultOn: false,
    align: 'right',
    minWidth: 72,
    getCell: (ctx) => ({
      display: fmtClock(ctx.elapsedS, ctx.reference),
      sortKey: ctx.elapsedS,
    }),
  },
  {
    id: 'elapsedTime',
    label: 'Temps',
    defaultOn: true,
    align: 'right',
    minWidth: 72,
    getCell: (ctx) => ({
      display: fmtSeconds(ctx.elapsedS),
      sortKey: ctx.elapsedS,
    }),
  },
  {
    id: 'segmentTimePrev',
    label: 'Temps depuis élément précédent',
    shortLabel: 'Δ prev',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const d = ctx.elapsedS != null && ctx.elapsedPrevS != null
        ? ctx.elapsedS - ctx.elapsedPrevS
        : null;
      return { display: fmtSeconds(d), sortKey: d };
    },
  },
  {
    id: 'segmentTimeNext',
    label: 'Temps jusqu’au prochain élément',
    shortLabel: 'Δ next',
    defaultOn: true,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const d = ctx.elapsedS != null && ctx.elapsedNextS != null
        ? ctx.elapsedNextS - ctx.elapsedS
        : null;
      return { display: fmtSeconds(d), sortKey: d };
    },
  },
  {
    id: 'avgSpeedFromStart',
    label: 'Vitesse moyenne depuis le début',
    shortLabel: 'V̄ depuis départ',
    defaultOn: true,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const v = avgSpeedFromElapsed(ctx.distanceM, ctx.elapsedS);
      return { display: fmtSpeed(v), sortKey: v };
    },
  },
  {
    id: 'avgSpeedSincePrev',
    label: 'Vitesse moyenne depuis l’élément précédent',
    shortLabel: 'V̄ depuis prev',
    defaultOn: false,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const v = avgSpeedBetween(ctx.prevDistanceM, ctx.distanceM, ctx.elapsedPrevS, ctx.elapsedS);
      return { display: fmtSpeed(v), sortKey: v };
    },
  },
  {
    id: 'avgSpeedToNext',
    label: 'Vitesse moyenne jusqu’au prochain élément',
    shortLabel: 'V̄ → next',
    defaultOn: false,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const v = avgSpeedBetween(ctx.distanceM, ctx.nextDistanceM, ctx.elapsedS, ctx.elapsedNextS);
      return { display: fmtSpeed(v), sortKey: v };
    },
  },
  {
    id: 'avgPowerFromStart',
    label: 'Puissance moyenne (depuis le début)',
    shortLabel: 'P̄ depuis départ',
    defaultOn: false,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const p = avgPowerBetween(ctx.prediction, 0, ctx.distanceM);
      return { display: fmtPower(p), sortKey: p };
    },
  },
  {
    id: 'avgPowerSincePrev',
    label: 'Puissance moyenne (depuis l’élément précédent)',
    shortLabel: 'P̄ depuis prev',
    defaultOn: false,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const p = avgPowerBetween(ctx.prediction, ctx.prevDistanceM, ctx.distanceM);
      return { display: fmtPower(p), sortKey: p };
    },
  },
  {
    id: 'avgPowerToNext',
    label: 'Puissance moyenne (jusqu’au prochain élément)',
    shortLabel: 'P̄ → next',
    defaultOn: false,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const p = avgPowerBetween(ctx.prediction, ctx.distanceM, ctx.nextDistanceM);
      return { display: fmtPower(p), sortKey: p };
    },
  },
  {
    id: 'gainFromStart',
    label: 'Dénivelé + (depuis le début)',
    shortLabel: 'D+ depuis départ',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const g = gainLossBetween(ctx.prediction, 0, ctx.distanceM)?.gain ?? null;
      return { display: fmtElevation(g), sortKey: g };
    },
  },
  {
    id: 'gainSincePrev',
    label: 'Dénivelé + (depuis l’élément précédent)',
    shortLabel: 'D+ depuis prev',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const g = gainLossBetween(ctx.prediction, ctx.prevDistanceM, ctx.distanceM)?.gain ?? null;
      return { display: fmtElevation(g), sortKey: g };
    },
  },
  {
    id: 'gainToNext',
    label: 'Dénivelé + (jusqu’au prochain élément)',
    shortLabel: 'D+ → next',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const g = gainLossBetween(ctx.prediction, ctx.distanceM, ctx.nextDistanceM)?.gain ?? null;
      return { display: fmtElevation(g), sortKey: g };
    },
  },
  {
    id: 'lossFromStart',
    label: 'Dénivelé - (depuis le début)',
    shortLabel: 'D- depuis départ',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const l = gainLossBetween(ctx.prediction, 0, ctx.distanceM)?.loss ?? null;
      return { display: fmtElevation(l), sortKey: l };
    },
  },
  {
    id: 'lossSincePrev',
    label: 'Dénivelé - (depuis l’élément précédent)',
    shortLabel: 'D- depuis prev',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const l = gainLossBetween(ctx.prediction, ctx.prevDistanceM, ctx.distanceM)?.loss ?? null;
      return { display: fmtElevation(l), sortKey: l };
    },
  },
  {
    id: 'lossToNext',
    label: 'Dénivelé - (jusqu’au prochain élément)',
    shortLabel: 'D- → next',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const l = gainLossBetween(ctx.prediction, ctx.distanceM, ctx.nextDistanceM)?.loss ?? null;
      return { display: fmtElevation(l), sortKey: l };
    },
  },
  {
    id: 'altitude',
    label: 'Altitude',
    defaultOn: false,
    align: 'right',
    minWidth: 72,
    getCell: (ctx) => {
      const a = ctx.point?.elevation_m ?? null;
      return { display: fmtElevation(a), sortKey: a };
    },
  },
  // ───── Weather columns ────────────────────────────────────────────────
  // No per-point weather data is sampled in the prediction; we render the
  // dash placeholder and keep the sort key null. When per-row weather is
  // wired later (e.g. via a `weatherByDistanceM` map), only the getCell
  // here needs updating.
  {
    id: 'wind',
    label: 'Vent',
    defaultOn: false,
    align: 'right',
    minWidth: 72,
    getCell: () => ({ display: DASH, sortKey: null }),
  },
  {
    id: 'temperature',
    label: 'Température',
    shortLabel: 'Temp.',
    defaultOn: false,
    align: 'right',
    minWidth: 72,
    getCell: () => ({ display: DASH, sortKey: null }),
  },
  {
    id: 'rain',
    label: 'Pluie',
    defaultOn: false,
    align: 'right',
    minWidth: 64,
    getCell: () => ({ display: DASH, sortKey: null }),
  },
  {
    id: 'cloudCover',
    label: 'Couverture nuageuse',
    shortLabel: 'Nuages',
    defaultOn: false,
    align: 'right',
    minWidth: 72,
    getCell: () => ({ display: DASH, sortKey: null }),
  },
];

export const TIMELINE_COLUMN_MAP: Readonly<Record<TimelineColumnId, TimelineColumnDef>> =
  Object.freeze(
    Object.fromEntries(TIMELINE_COLUMNS.map((c) => [c.id, c])) as Record<
      TimelineColumnId,
      TimelineColumnDef
    >,
  );

export const DEFAULT_TIMELINE_COLUMN_VISIBILITY: Record<TimelineColumnId, boolean> =
  Object.freeze(
    Object.fromEntries(
      TIMELINE_COLUMNS.map((c) => [c.id, c.defaultOn]),
    ) as Record<TimelineColumnId, boolean>,
  );

// ─────────────────────────────────────────────────────────────────────────────
// Context builder.
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildContextArgs {
  item: TimelineItem;
  prevItem: TimelineItem | null;
  nextItem: TimelineItem | null;
  totalDistanceM: number;
  prediction: PredictionResult | null | undefined;
  rhythm: RhythmState | undefined;
  reference: StartReference;
}

export function buildTimelineColumnContext(args: BuildContextArgs): TimelineColumnContext {
  const distanceM = toMeters(args.item.distanceKm);
  const prevDistanceM = toMeters(args.prevItem?.distanceKm ?? null);
  const nextDistanceM = toMeters(args.nextItem?.distanceKm ?? null);
  const elapsedS = elapsedSecondsAtDistance(args.prediction ?? null, distanceM ?? 0, args.totalDistanceM);
  const elapsedPrevS = prevDistanceM != null
    ? elapsedSecondsAtDistance(args.prediction ?? null, prevDistanceM, args.totalDistanceM)
    : null;
  const elapsedNextS = nextDistanceM != null
    ? elapsedSecondsAtDistance(args.prediction ?? null, nextDistanceM, args.totalDistanceM)
    : null;
  return {
    item: args.item,
    prevItem: args.prevItem,
    nextItem: args.nextItem,
    distanceM,
    prevDistanceM,
    nextDistanceM,
    totalDistanceM: args.totalDistanceM,
    prediction: args.prediction,
    rhythm: args.rhythm,
    reference: args.reference,
    elapsedS: distanceM != null ? elapsedS : null,
    elapsedPrevS,
    elapsedNextS,
    point: pointAtDistanceM(args.prediction, distanceM),
    pointPrev: pointAtDistanceM(args.prediction, prevDistanceM),
    pointNext: pointAtDistanceM(args.prediction, nextDistanceM),
  };
}

function toMeters(km: number | null | undefined): number | null {
  if (km == null || !Number.isFinite(km)) return null;
  return km * 1000;
}
