/** Position + orientation de la caméra libre (altitude absolue, en mètres). */
export interface FreeCamPose {
  lng: number;
  lat: number;
  altitudeM: number;
  /**
   * Convention Mapbox : 0 = regard vertical vers le sol, 90 = horizon.
   * Au-delà de 84.9 (limite Mapbox), le surplus passe en décalage optique (`lensShift`).
   */
  pitch: number;
  /** Degrés, 0 = nord, sens horaire. */
  bearing: number;
}

export type FreeCamAction = 'forward' | 'backward' | 'left' | 'right' | 'ascend' | 'descend';

/** Axes normalisés de l'input clavier, chacun dans [-1, 1]. */
export interface FreeCamAxes {
  /** +1 = avancer, -1 = reculer. */
  forward: number;
  /** +1 = droite, -1 = gauche. */
  strafe: number;
  /** +1 = monter, -1 = descendre. */
  vertical: number;
}

/** Delta souris accumulé depuis la dernière frame, en pixels. */
export interface FreeCamLookDelta {
  dx: number;
  dy: number;
}
