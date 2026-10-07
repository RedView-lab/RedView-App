// ============================================
// LiDAR viewer tools — ground cover along a fall line (from the point cloud)
// ============================================
//
// The ground model has no trees, buildings or water: they are read from the
// LiDAR returns themselves (ASPRS classes) on a small grid around the path.
// Trees and buildings are obstacles hit by a sliding body; a forest also
// brakes falling rocks; water at the end of a slide is a trap of its own.

import type { SlideCover } from './fallSlide';
import type { TerrainField } from './terrainField';

/** Cell of the cover grid, m. */
const COVER_CELL_M = 2;
/** A return of the high-vegetation class this high above the ground is a tree (m). */
const TREE_MIN_HEIGHT_M = 3;
const BUILDING_MIN_HEIGHT_M = 2;
/** Share of tree cells around a cell (3 × 3) from which it is forest. */
const FOREST_MIN_SHARE = 4 / 9;

const TREE = 1;
const BUILDING = 2;
const WATER = 4;

export interface CoverBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class FallCover implements SlideCover {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  private readonly flags: Uint8Array;
  /** The cloud has ground returns (class 2): the ground model is a real DTM. */
  readonly groundClassified: boolean;

  constructor(bounds: CoverBounds, flags: Uint8Array, width: number, height: number, groundClassified: boolean) {
    this.originX = bounds.minX;
    this.originY = bounds.minY;
    this.width = width;
    this.height = height;
    this.flags = flags;
    this.groundClassified = groundClassified;
  }

  private cellAt(projX: number, projY: number): number {
    const col = Math.floor((projX - this.originX) / COVER_CELL_M);
    const row = Math.floor((projY - this.originY) / COVER_CELL_M);
    if (col < 0 || row < 0 || col >= this.width || row >= this.height) return -1;
    return row * this.width + col;
  }

  private has(projX: number, projY: number, flag: number): boolean {
    const i = this.cellAt(projX, projY);
    return i >= 0 && (this.flags[i]! & flag) !== 0;
  }

  hasTree(projX: number, projY: number): boolean {
    return this.has(projX, projY, TREE);
  }

  hasBuilding(projX: number, projY: number): boolean {
    return this.has(projX, projY, BUILDING);
  }

  hasWater(projX: number, projY: number): boolean {
    return this.has(projX, projY, WATER);
  }

  isForest(projX: number, projY: number): boolean {
    const i = this.cellAt(projX, projY);
    if (i < 0) return false;
    const col = i % this.width;
    const row = (i - col) / this.width;
    let trees = 0;
    let cells = 0;
    for (let r = row - 1; r <= row + 1; r++) {
      for (let c = col - 1; c <= col + 1; c++) {
        if (c < 0 || r < 0 || c >= this.width || r >= this.height) continue;
        cells++;
        if ((this.flags[r * this.width + c]! & TREE) !== 0) trees++;
      }
    }
    return cells > 0 && trees / cells >= FOREST_MIN_SHARE;
  }
}

/** Collects classified returns into a cover grid over `bounds`. */
export class FallCoverBuilder {
  private readonly field: TerrainField;
  private readonly bounds: CoverBounds;
  private readonly width: number;
  private readonly height: number;
  private readonly flags: Uint8Array;
  private groundCount = 0;
  private otherCount = 0;

  constructor(field: TerrainField, bounds: CoverBounds) {
    this.field = field;
    this.bounds = bounds;
    this.width = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / COVER_CELL_M));
    this.height = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / COVER_CELL_M));
    this.flags = new Uint8Array(this.width * this.height);
  }

  add(projX: number, projY: number, altitudeM: number, classification: number): void {
    const col = Math.floor((projX - this.bounds.minX) / COVER_CELL_M);
    const row = Math.floor((projY - this.bounds.minY) / COVER_CELL_M);
    if (col < 0 || row < 0 || col >= this.width || row >= this.height) return;
    if (classification === 2) {
      this.groundCount++;
      return;
    }
    this.otherCount++;
    let flag = 0;
    if (classification === 9) {
      flag = WATER;
    } else if (classification === 5 || classification === 6) {
      const ground = this.field.altitudeAt(projX, projY);
      if (ground == null) return;
      const above = altitudeM - ground;
      if (classification === 5 && above >= TREE_MIN_HEIGHT_M) flag = TREE;
      else if (classification === 6 && above >= BUILDING_MIN_HEIGHT_M) flag = BUILDING;
    }
    if (flag) this.flags[row * this.width + col]! |= flag;
  }

  finish(): FallCover {
    // Some ground among the returns: the cloud is classified (a handful of
    // ground returns in a fully unclassified cloud would be noise).
    const groundClassified = this.groundCount > 0.02 * (this.groundCount + this.otherCount);
    return new FallCover(this.bounds, this.flags, this.width, this.height, groundClassified);
  }
}
