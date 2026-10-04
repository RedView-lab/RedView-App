// ============================================
// LiDAR viewer tools — canopy cover from the point cloud (avalanche forest input)
// ============================================
//
// AutoATES takes forest density as percent canopy cover: the share of the
// ground hidden by tree crowns seen from above. Here it is read from the
// LiDAR returns themselves: a 2 m column holding a high-vegetation return
// (ASPRS class 5) at least 3 m above the ground model is under a crown; the
// cover of a grid cell is the share of its columns under a crown, among the
// columns holding any return (so a sparser LOD level gives the same share).
// A cloud without ground classification gives no forest: open terrain is
// assumed, as AutoATES does without a forest layer.

import type { AnalysisGrid, TerrainField } from '../terrainField';
import { TREE_MIN_HEIGHT_M } from './params';

/** Edge of the crown-detection columns, m. */
const COLUMN_M = 2;
const HIGH_VEGETATION = 5;
const GROUND = 2;
const ANY = 1;
const CROWN = 2;

export interface CanopyCover {
  /** Canopy cover per grid cell, 0–100 (NaN: no return in the cell). */
  canopyPct: Float32Array;
}

export class CanopyGridBuilder {
  private readonly field: TerrainField;
  private readonly grid: AnalysisGrid;
  private readonly column: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly flags: Uint8Array;
  private groundCount = 0;
  private otherCount = 0;

  constructor(field: TerrainField, grid: AnalysisGrid) {
    this.field = field;
    this.grid = grid;
    // Columns tile the grid cells exactly (a whole number per cell edge).
    const perCell = Math.max(1, Math.round(grid.cell / COLUMN_M));
    this.column = grid.cell / perCell;
    this.minX = grid.originX - grid.cell / 2;
    this.minY = grid.originY - grid.cell / 2;
    this.cols = grid.width * perCell;
    this.rows = grid.height * perCell;
    this.flags = new Uint8Array(this.cols * this.rows);
  }

  /** Plan box of the grid, CRS metres. */
  get bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    return {
      minX: this.minX,
      minY: this.minY,
      maxX: this.minX + this.grid.width * this.grid.cell,
      maxY: this.minY + this.grid.height * this.grid.cell,
    };
  }

  add(projX: number, projY: number, altitudeM: number, classification: number): void {
    const c = Math.floor((projX - this.minX) / this.column);
    const r = Math.floor((projY - this.minY) / this.column);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return;
    if (classification === GROUND) this.groundCount++;
    else this.otherCount++;
    const i = r * this.cols + c;
    let flag = ANY;
    if (classification === HIGH_VEGETATION && !(this.flags[i]! & CROWN)) {
      const ground = this.field.altitudeAt(projX, projY);
      if (ground != null && altitudeM - ground >= TREE_MIN_HEIGHT_M) flag |= CROWN;
    }
    this.flags[i]! |= flag;
  }

  /** `null` when the cloud carries no ground classification (forest unknown). */
  finish(): CanopyCover | null {
    // A handful of ground returns in an unclassified cloud would be noise.
    if (!(this.groundCount > 0.02 * (this.groundCount + this.otherCount))) return null;
    const { width, height } = this.grid;
    const perCell = this.cols / width;
    const canopyPct = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        let any = 0;
        let crown = 0;
        for (let r = row * perCell; r < (row + 1) * perCell; r++) {
          for (let c = col * perCell; c < (col + 1) * perCell; c++) {
            const f = this.flags[r * this.cols + c]!;
            if (f & ANY) any++;
            if (f & CROWN) crown++;
          }
        }
        canopyPct[row * width + col] = any > 0 ? (100 * crown) / any : Number.NaN;
      }
    }
    return { canopyPct };
  }
}
