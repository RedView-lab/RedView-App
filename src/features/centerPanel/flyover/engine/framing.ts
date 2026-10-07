import {
  CENTERLINE_MAX_OFFSET_PER_DISTANCE,
  FLYOVER_FOV_DEG,
  PORTRAIT_CENTERLINE_MAX_OFFSET_PER_DISTANCE,
  PORTRAIT_DISTANCE_FACTOR,
  PORTRAIT_FOV_DEG,
  PORTRAIT_TARGET_LEAD_PER_DISTANCE,
  TARGET_LEAD_PER_DISTANCE,
} from '../config';
import { fovDistanceFactor } from './laws';

/**
 * Cadrage de la caméra pour un format d'image. La loi vitesse → distance de
 * cadrage (`cameraDistanceForSpeed`) est commune à tous les formats ; le
 * cadrage dit comment l'image la montre : champ vertical, recul, avance du
 * point visé et écart latéral permis entre la tête et la ligne visée.
 */
export interface FlyoverFraming {
  /** Champ de vision vertical (degrés). */
  readonly fovDeg: number;
  /** Distance œil → point visé = distance de cadrage × ce facteur. */
  readonly distanceFactor: number;
  /** Point visé en avance sur la tête (fraction de la distance de cadrage). */
  readonly targetLeadPerDistance: number;
  /** Écart latéral max tête ↔ ligne visée (fraction de la distance de cadrage). */
  readonly centerlineMaxOffsetPerDistance: number;
}

/**
 * Paysage (écran, vidéo 16:9) : champ `fovDeg`, recul tel que la hauteur
 * visible au point visé reste celle du champ Mapbox par défaut.
 */
export function landscapeFraming(fovDeg: number = FLYOVER_FOV_DEG): FlyoverFraming {
  return {
    fovDeg,
    distanceFactor: fovDistanceFactor(fovDeg),
    targetLeadPerDistance: TARGET_LEAD_PER_DISTANCE,
    centerlineMaxOffsetPerDistance: CENTERLINE_MAX_OFFSET_PER_DISTANCE,
  };
}

/**
 * Portrait (vidéo 9:16). L'image est 3,2× moins large que haute : champ
 * vertical ouvert (la route file vers le haut de l'image), recul tel qu'un
 * pixel couvre le même terrain qu'en 16:9 (même niveau de détail), point visé
 * plus loin devant (tête dans le tiers inférieur) et ligne visée tenue plus
 * près de la trace (la largeur visible est ~0,55× celle du 16:9).
 */
export function portraitFraming(): FlyoverFraming {
  return {
    fovDeg: PORTRAIT_FOV_DEG,
    distanceFactor: PORTRAIT_DISTANCE_FACTOR,
    targetLeadPerDistance: PORTRAIT_TARGET_LEAD_PER_DISTANCE,
    centerlineMaxOffsetPerDistance: PORTRAIT_CENTERLINE_MAX_OFFSET_PER_DISTANCE,
  };
}

