/**
 * Where the benchmarks find the real-world data that is not versioned (GPX of
 * reference routes, FIT rides, exports): one directory, `REDVIEW_BENCH_DATA`,
 * defaulting to the user's Downloads folder. Suite-specific variables
 * (`PACE_FIT_DIR`, `AUDIT_GPX_DIR`, …) still override a single input.
 */
import os from 'node:os';
import path from 'node:path';

export const BENCH_DATA_DIR = process.env.REDVIEW_BENCH_DATA ?? path.join(os.homedir(), 'Downloads');

/** Path of a file of the bench data directory. */
export function benchDataFile(...segments: string[]): string {
  return path.join(BENCH_DATA_DIR, ...segments);
}

/** GT20 reference route (Grande Traversée du 20e), used by the pace, POI and audit suites. */
export const GT20_GPX = benchDataFile('GT20.gpx');

/** Chamonix → Paris FIT rides (pace engine ground truth). */
export const CHAM_PARIS_FIT_DIR = benchDataFile('wetransfer_cham_paris_a_velo_jour_1-fit_2026-09-24_1025');
