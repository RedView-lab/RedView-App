export interface NzTileCoord {
  eastKm: number;
  northKm: number;
}

/**
 * Dossier de nuages de points LINZ indexé (`nzLazIndex.ts`, généré par
 * `npm run lidar:index`), servi par OpenTopography.
 */
export interface NzLidarDataset {
  id: string;
  year: number;
  /** Densité médiane (pts/m²). */
  density: number;
  /** Préfixe d'URL du dossier. */
  base: string;
  /** Échelle de la grille Topo50 (500, 1000, 2000), 0 pour une grille propre. */
  scale: 0 | 500 | 1000 | 2000;
  /** Gabarit du nom de fichier (`{sheet}`, `{rc}`) pour une grille Topo50. */
  name: string;
  /** Feuilles Topo50 (« BW23 », 4 car.) suivies du masque hex de leurs dalles présentes. */
  sheets?: string;
  /** Grille propre : `fichier|minE|minN|maxE|maxN` séparés par `;` (NZTM, m). */
  tiles?: string;
}
