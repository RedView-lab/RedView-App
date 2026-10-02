/**
 * Legend rule shared by the cumulative-sunshine renderers (map overlay worker
 * and LiDAR viewer), so one exposure always lands in the same band: bands are
 * sorted by `minMinutes`, a value belongs to the first band whose `maxMinutes`
 * it has not reached, and anything beyond stays in the last band. Zero minutes
 * is a real value (the first band of the legend starts at 0).
 */
export interface SunlightBandRange {
  minMinutes: number;
  maxMinutes: number;
}

export function sortSunlightBands<T extends SunlightBandRange>(bands: readonly T[]): T[] {
  return [...bands].sort((a, b) => a.minMinutes - b.minMinutes);
}

/** Index into `sortedBands` (see `sortSunlightBands`), -1 when there is no band. */
export function sunlightBandIndex(minutes: number, sortedBands: readonly SunlightBandRange[]): number {
  const last = sortedBands.length - 1;
  for (let b = 0; b < last; b++) {
    if (minutes < sortedBands[b]!.maxMinutes) return b;
  }
  return last;
}
