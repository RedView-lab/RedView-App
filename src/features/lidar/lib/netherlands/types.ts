/**
 * Jeu AHN indexé (`ahnIndex.ts`, généré par `npm run lidar:index`), servi par
 * GeoTiles en sous-dalles de 1 × 1,25 km (`65AN2_01` … `_25`).
 */
export interface AhnDataset {
  id: string;
  /** Années d'acquisition (« 2020–2022 »). */
  years: string;
  /** Préfixe d'URL des sous-dalles (`<feuille>_<nn>.LAZ`). */
  base: string;
  /** Feuilles (5 car., « 65AN2 ») suivies du masque hex (7 car.) de leurs 25 sous-dalles présentes. */
  sheets: string;
}
