export type JapanZoneNumber =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19;

/** Tuile de 1 km x 1 km dans le système plan rectangulaire japonais (JGD2011, zones 1..19) */
export interface JapanTileCoord {
  eastKm: number;
  northKm: number;
  zone: JapanZoneNumber;
}

/**
 * Jeu de nuages de points LiDAR indexé (`japanLazIndex.ts`, généré par
 * `npm run lidar:index`). Un fichier = une feuille du 公共測量標準図郭.
 */
export interface JapanLidarDataset {
  id: string;
  label: string;
  year: number;
  /** Densité médiane (pts/m²). */
  density: number;
  zone: JapanZoneNumber;
  /**
   * Découpage de la feuille 1:5000 : 500 = 10×10 (300 × 400 m, `09KC3164`),
   * 1250 = quart puis quart de quart (750 × 1000 m, `09LD3344`), 2500 =
   * quarts (1,5 × 2 km, `09JB683`) ; 0 = emprise stockée par fichier (`tiles`).
   */
  level: 0 | 500 | 1250 | 2500;
  /** Préfixe d'URL, puis `dir` (jetons `{z}` `{L}` `{s}`), le code et `ext`. */
  base: string;
  dir: string;
  ext: string;
  /** Code de feuille et jetons du dossier en minuscules. */
  lower: boolean;
  /** Feuilles 1:5000 (« ME28 », 4 car.) suivies du masque hex de leurs sous-feuilles présentes. */
  sheets?: string;
  /** `level` 0 : `fichier|minE|minN|maxE|maxN` séparés par `;` (m, zone `zone`). */
  tiles?: string;
}
