// ============================================
// LiDAR viewer — memory budget of a first scene load
// ============================================
//
// A tile seen for the first time goes through two stages: (1) read, decode
// (every core), colourise and copy its ground points for the relief, then
// (2) build its LOD octree and write it to OPFS (one core). Both hold the
// tile's points in memory. Loading tiles one after the other left fifteen
// cores idle for most of a tile (colourisation and LOD are single-threaded:
// 133 s for the 9-tile test scene, 2026-10-07), three at once took 7.65 GB.
// The pipeline below decodes the next tile while the previous one builds its
// LOD — one tile per stage, and only when both stages' memory fits a budget
// drawn from the device memory; a tile alone always runs.

/**
 * Bytes per point a tile adds to the tab in each stage, measured in Edge on
 * the IGN LiDAR HD 9-tile scene (2026-10-07, peak over the tab before the
 * tile; decode in batches, see workers/copcDecodeWorker.ts): 38 B while
 * decoding (its arrays, the compressed chunks in the decode workers, their
 * WASM memory, the orthophotos), 36 B while building its LOD (input arrays
 * and the 16 B packed records) — 38 B kept for both.
 */
export const DECODE_BYTES_PER_POINT = 38;
export const LOD_BUILD_BYTES_PER_POINT = 38;
/** Share of the device memory a scene load may hold in tiles being loaded. */
const BUDGET_SHARE_OF_DEVICE_MEMORY = 0.4;
/** `navigator.deviceMemory` is capped at 8 GiB and missing outside Chromium. */
const DEFAULT_DEVICE_MEMORY_GIB = 8;

/** Bytes the tiles being loaded for the first time may hold at once. */
export function getSceneMemoryBudgetBytes(deviceMemoryGiB?: number): number {
  const gib = deviceMemoryGiB !== undefined && Number.isFinite(deviceMemoryGiB) && deviceMemoryGiB > 0
    ? Math.min(deviceMemoryGiB, DEFAULT_DEVICE_MEMORY_GIB)
    : DEFAULT_DEVICE_MEMORY_GIB;
  return Math.floor(gib * 2 ** 30 * BUDGET_SHARE_OF_DEVICE_MEMORY);
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
 * Two-stage pipeline of first tile loads: at most one tile decoding and one
 * building its LOD. A tile enters the decode stage, in arrival order, once
 * the stage is free and its decode bytes fit next to the LOD build in
 * progress; it then waits for the build stage and swaps its decode bytes for
 * its build bytes. The build stage never waits on anything, so the pipeline
 * cannot deadlock; a tile heavier than the budget runs alone.
 */
export class TileLoadPipeline {
  private readonly budgetBytes: number;
  private heldBytes = 0;
  /** The decode stage is taken from admission until the tile enters the build stage. */
  private decodeBusy = false;
  private buildBusy = false;
  private readonly waitingDecode: Array<{ bytes: number; start: () => void }> = [];
  private waitingBuild: (() => void) | null = null;

  constructor(budgetBytes: number) {
    this.budgetBytes = budgetBytes;
  }

  /** Bytes held by the tiles in the pipeline (for tests and diagnostics). */
  get held(): number {
    return this.heldBytes;
  }

  run<D, B>(points: number, decode: () => Promise<D>, build: (decoded: D) => Promise<B>): Promise<B> {
    const decodeBytes = points * DECODE_BYTES_PER_POINT;
    const buildBytes = points * LOD_BUILD_BYTES_PER_POINT;
    return new Promise<B>((resolve, reject) => {
      const enterBuild = (decoded: D) => {
        this.buildBusy = true;
        this.heldBytes += buildBytes - decodeBytes;
        this.decodeBusy = false;
        build(decoded).then(resolve, reject).finally(() => {
          this.heldBytes -= buildBytes;
          this.buildBusy = false;
          const next = this.waitingBuild;
          this.waitingBuild = null;
          if (next) next();
          else this.admit();
        });
        this.admit();
      };
      this.waitingDecode.push({
        bytes: decodeBytes,
        start: () => {
          this.decodeBusy = true;
          this.heldBytes += decodeBytes;
          decode().then(
            (decoded) => {
              if (this.buildBusy) this.waitingBuild = () => enterBuild(decoded);
              else enterBuild(decoded);
            },
            (error: unknown) => {
              this.heldBytes -= decodeBytes;
              this.decodeBusy = false;
              this.admit();
              reject(error);
            },
          );
        },
      });
      this.admit();
    });
  }

  private admit(): void {
    if (this.decodeBusy) return;
    const next = this.waitingDecode[0];
    if (!next) return;
    if (this.heldBytes > 0 && this.heldBytes + next.bytes > this.budgetBytes) return;
    this.waitingDecode.shift();
    next.start();
  }
}
