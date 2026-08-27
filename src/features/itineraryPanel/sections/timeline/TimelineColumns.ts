/**
 * Roadbook "Feuille de route" — column registry.
 *
 * Single source of truth for every column the user can toggle in the sheet
 * view. Each column knows how to render its header label and compute its cell value.
 */

import { elapsedSecondsAtDistance } from '@/features/centerPanel/flyover/playback';
import { pointAtDistanceM } from './timelineColumnsFormatters';
import { TIMELINE_COLUMNS } from './timelineColumnsRegistry';
import type {
  BuildContextArgs,
  TimelineColumnContext,
  TimelineColumnDef,
  TimelineColumnId,
} from './TimelineColumnsTypes';

export * from './TimelineColumnsTypes';
export * from './timelineColumnsFormatters';
export * from './timelineColumnsRegistry';

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

function toMeters(km: number | null | undefined): number | null {
  if (km == null || !Number.isFinite(km)) return null;
  return km * 1000;
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
