// ============================================
// Outils du viewer LiDAR — couvert du sol le long d'une ligne de chute (d'après le nuage de points)
// ============================================
//
// Le modèle de sol n'a ni arbres, ni bâtiments, ni eau : ils sont lus dans les
// retours LiDAR eux-mêmes (classes ASPRS) sur une petite grille autour de la
// trajectoire. Arbres et bâtiments sont des obstacles qu'un corps qui glisse
// heurte ; une forêt freine aussi les chutes de pierres ; l'eau au bout d'une
// glissade est un piège à elle seule.

import type { SlideCover } from './fallSlide';
import type { TerrainField } from './terrainField';

/** Cellule de la grille de couvert, m. */
const COVER_CELL_M = 2;
/** Un retour de la classe haute végétation à cette hauteur au-dessus du sol est un arbre (m). */
const TREE_MIN_HEIGHT_M = 3;
const BUILDING_MIN_HEIGHT_M = 2;
/** Part de cellules d'arbre autour d'une cellule (3 × 3) à partir de laquelle c'est une forêt. */
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
  /** Le nuage a des retours sol (classe 2) : le modèle de sol est un vrai MNT. */
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

/** Rassemble les retours classés dans une grille de couvert sur `bounds`. */
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
    // Un peu de sol parmi les retours : le nuage est classé (une poignée de
    // retours sol dans un nuage entièrement non classé serait du bruit).
    const groundClassified = this.groundCount > 0.02 * (this.groundCount + this.otherCount);
    return new FallCover(this.bounds, this.flags, this.width, this.height, groundClassified);
  }
}
