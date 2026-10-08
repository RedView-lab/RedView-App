// ============================================
// Outils du viewer LiDAR — couvert de canopée d'après le nuage de points (entrée forêt des avalanches)
// ============================================
//
// AutoATES prend la densité de forêt en pourcentage de couvert de canopée : la
// part du sol cachée par les couronnes vue du dessus. Elle est lue ici dans les
// retours LiDAR eux-mêmes : une colonne de 2 m contenant un retour de haute
// végétation (classe ASPRS 5) à au moins 3 m au-dessus du modèle de sol est sous
// une couronne ; le couvert d'une cellule de grille est la part de ses colonnes
// sous une couronne, parmi les colonnes contenant un retour (un niveau LOD plus
// clairsemé donne donc la même part). Un nuage sans classification du sol ne
// donne pas de forêt : terrain ouvert supposé, comme AutoATES sans couche forêt.

import type { AnalysisGrid, TerrainField } from '../terrainField';
import { TREE_MIN_HEIGHT_M } from './params';

/** Côté des colonnes de détection des couronnes, m. */
const COLUMN_M = 2;
const HIGH_VEGETATION = 5;
const GROUND = 2;
const ANY = 1;
const CROWN = 2;

export interface CanopyCover {
  /** Couvert de canopée par cellule de grille, 0–100 (NaN : aucun retour dans la cellule). */
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
    // Les colonnes pavent exactement les cellules de la grille (un nombre entier par côté de cellule).
    const perCell = Math.max(1, Math.round(grid.cell / COLUMN_M));
    this.column = grid.cell / perCell;
    this.minX = grid.originX - grid.cell / 2;
    this.minY = grid.originY - grid.cell / 2;
    this.cols = grid.width * perCell;
    this.rows = grid.height * perCell;
    this.flags = new Uint8Array(this.cols * this.rows);
  }

  /** Boîte en plan de la grille, mètres CRS. */
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

  /** `null` quand le nuage ne porte pas de classification du sol (forêt inconnue). */
  finish(): CanopyCover | null {
    // Une poignée de retours sol dans un nuage non classé serait du bruit.
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
