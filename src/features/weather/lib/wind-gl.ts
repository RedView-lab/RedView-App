/** Grille de vent décodée depuis les tuiles météo du VPS (utilisée par la couche de vent). */
export interface WindData {
  /** Grille Float32 : 3 flottants par texel [u, v, vitesse] (ligne par ligne, haut = nord). */
  image: Float32Array;
  width: number;
  height: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  speedMin: number;
  speedMax: number;
}
