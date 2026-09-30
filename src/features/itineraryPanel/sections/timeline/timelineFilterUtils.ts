import type { TimelineFilterState } from './TimelineFilters';

/** Égalité par valeur (Set de catégories inclus ; `undefined` = toutes). */
export function sameTimelineFilters(
  a: TimelineFilterState | null | undefined,
  b: TimelineFilterState | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.etape !== b.etape
    || a.waypoint !== b.waypoint
    || a.poi !== b.poi
    || a.pause !== b.pause
    || a.favorite !== b.favorite
  ) {
    return false;
  }
  if (a.categories === b.categories) return true;
  if (!a.categories || !b.categories || a.categories.size !== b.categories.size) return false;
  for (const category of a.categories) {
    if (!b.categories.has(category)) return false;
  }
  return true;
}
