// ============================================
// LiDAR viewer — memory budget of a first scene load
// ============================================
//
// A tile seen for the first time is decoded, colourised and turned into its
// LOD cache in memory: 41–45 B per point at the peak (decoded arrays, LOD
// blocks being packed, ground points copied for the heightmap). Three dense
// IGN tiles at once (143 M points) took 7.65 GB in the tab (2026-10-07,
// 9-tile scene): an 8 GB machine runs out. Tiles therefore start only while
// the points in flight fit a budget drawn from the device memory; a tile that
// does not fit waits for the others, and one alone always runs.

/**
 * Peak bytes per point of a first tile load, with a margin: 41–45 B measured
 * in the tab on IGN LiDAR HD tiles (55.8 M points: 3.47 GB peak over 1.0–1.2 GB
 * once loaded). 48 B was tried (2026-10-07, 9-tile scene, 3 interleaved runs
 * each): median 141 s vs 151 s, within the noise, for a 4.6 GB peak instead
 * of 3.9 GB — the margin stays.
 */
export const FIRST_LOAD_BYTES_PER_POINT = 60;
/** Share of the device memory a scene load may hold in decoded tiles. */
const BUDGET_SHARE_OF_DEVICE_MEMORY = 0.4;
/** `navigator.deviceMemory` is capped at 8 GiB and missing outside Chromium. */
const DEFAULT_DEVICE_MEMORY_GIB = 8;

/** Points that may be loaded for the first time at once. */
export function getScenePointBudget(deviceMemoryGiB?: number): number {
  const gib = deviceMemoryGiB !== undefined && Number.isFinite(deviceMemoryGiB) && deviceMemoryGiB > 0
    ? Math.min(deviceMemoryGiB, DEFAULT_DEVICE_MEMORY_GIB)
    : DEFAULT_DEVICE_MEMORY_GIB;
  return Math.floor((gib * 2 ** 30 * BUDGET_SHARE_OF_DEVICE_MEMORY) / FIRST_LOAD_BYTES_PER_POINT);
}

/**
 * Point count of a LAS/LAZ file from its public header (first 375 bytes are
 * enough): the 64-bit count of LAS 1.4 when present, else the legacy 32-bit
 * one; null when the bytes are not a LAS header.
 */
export function readLasPointCount(header: ArrayBuffer): number | null {
  if (header.byteLength < 227) return null;
  const view = new DataView(header);
  if (view.getUint32(0, false) !== 0x4c415346) return null; // "LASF"
  const minor = view.getUint8(25);
  const headerSize = view.getUint16(94, true);
  if (minor >= 4 && headerSize >= 375 && header.byteLength >= 255) {
    const count = Number(view.getBigUint64(247, true));
    if (count > 0) return count;
  }
  return view.getUint32(107, true);
}

/**
 * Admits weighted tasks while their weights in flight fit the budget, in
 * arrival order (a big task is not starved by small ones behind it). A task
 * heavier than the budget runs alone.
 */
export class PointBudgetGate {
  private readonly budget: number;
  private inFlight = 0;
  private running = 0;
  private readonly queue: Array<{ weight: number; start: () => void }> = [];

  constructor(budget: number) {
    this.budget = budget;
  }

  /** Runs `task` once admitted; it gets the number of tasks running with it (itself included). */
  run<T>(weight: number, task: (running: number) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.inFlight += weight;
        this.running++;
        task(this.running).then(resolve, reject).finally(() => {
          this.inFlight -= weight;
          this.running--;
          this.admit();
        });
      };
      this.queue.push({ weight, start });
      this.admit();
    });
  }

  private admit(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (this.running > 0 && this.inFlight + next.weight > this.budget) return;
      this.queue.shift();
      next.start();
    }
  }
}
