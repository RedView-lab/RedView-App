/** Masque des cellules DHMV II couvertes (`dhmvIndex.ts`, généré par `npm run lidar:index`). */
export interface DhmvCellGrid {
  /** Colonne / ligne (unités de cellule, Lambert 72 / taille) de la première cellule du masque. */
  minCol: number;
  minRow: number;
  cols: number;
  rows: number;
  /** Masque hex, ligne par ligne depuis le sud, 4 cellules par caractère. */
  mask: string;
}

/** Morceau de bande de vol DHMV II d'une cellule. */
export interface DhmvStrip {
  /** URL amont (hors proxy). */
  url: string;
  points: number;
}
