import type { FreeCamAxes, FreeCamPose } from '../types';
import { horizontalDisplacementM, offsetLngLat } from './motion';

/**
 * Vélocité de la caméra libre, dans le repère local est / nord / haut (m/s).
 * Elle tend vers la vitesse demandée par le clavier par un amortissement
 * exponentiel (indépendant du nombre d'images par seconde) : accélération
 * franche quand une touche est tenue, glisse plus longue au relâchement.
 * Repère monde, pas caméra : tourner la souris en pleine vitesse garde l'élan
 * dans l'ancienne direction puis s'aligne sur la nouvelle (dérapage court).
 */
export interface FreeCamVelocity {
  eastMps: number;
  northMps: number;
  upMps: number;
}

export interface FreeCamVelocityResponse {
  /** Constante de temps vers une vitesse demandée non nulle (s). */
  accelerateTimeS: number;
  /** Constante de temps vers l'arrêt, touches relâchées (s). */
  brakeTimeS: number;
}

export const ZERO_VELOCITY: FreeCamVelocity = Object.freeze({ eastMps: 0, northMps: 0, upMps: 0 });

/** Vitesse visée par l'input de cette frame. */
export function targetVelocity(
  bearingDeg: number,
  axes: FreeCamAxes,
  horizontalSpeedMps: number,
  verticalSpeedMps: number,
): FreeCamVelocity {
  // Déplacement sur 1 s = vitesse.
  const { eastM, northM } = horizontalDisplacementM(bearingDeg, axes, horizontalSpeedMps, 1);
  return { eastMps: eastM, northMps: northM, upMps: axes.vertical * verticalSpeedMps };
}

function approach(current: number, target: number, timeS: number, dtSec: number): number {
  if (timeS <= 0) return target;
  return target + (current - target) * Math.exp(-dtSec / timeS);
}

/**
 * Rapproche la vitesse courante de la vitesse visée. Horizontal et vertical
 * ont chacun leur constante : lâcher « monter » en avançant freine la montée
 * sans adoucir l'avance.
 */
export function approachVelocity(
  current: FreeCamVelocity,
  target: FreeCamVelocity,
  dtSec: number,
  response: FreeCamVelocityResponse,
): FreeCamVelocity {
  const horizontalTimeS = target.eastMps !== 0 || target.northMps !== 0 ? response.accelerateTimeS : response.brakeTimeS;
  const verticalTimeS = target.upMps !== 0 ? response.accelerateTimeS : response.brakeTimeS;
  return {
    eastMps: approach(current.eastMps, target.eastMps, horizontalTimeS, dtSec),
    northMps: approach(current.northMps, target.northMps, horizontalTimeS, dtSec),
    upMps: approach(current.upMps, target.upMps, verticalTimeS, dtSec),
  };
}

export function velocityMagnitude(velocity: FreeCamVelocity): number {
  return Math.hypot(velocity.eastMps, velocity.northMps, velocity.upMps);
}

/**
 * Fin de glisse : sous `restSpeedMps` (une fraction de la vitesse du moment)
 * et sans input, la caméra s'arrête net au lieu de ramper indéfiniment —
 * la carte n'est alors plus touchée (zéro dérive au repos).
 */
export function settleVelocity(velocity: FreeCamVelocity, target: FreeCamVelocity, restSpeedMps: number): FreeCamVelocity {
  if (velocityMagnitude(target) > 0) return velocity;
  return velocityMagnitude(velocity) < restSpeedMps ? ZERO_VELOCITY : velocity;
}

/** Déplace la pose selon la vitesse pendant `dtSec` (orientation inchangée). */
export function advancePoseByVelocity(pose: FreeCamPose, velocity: FreeCamVelocity, dtSec: number): FreeCamPose {
  const [lng, lat] = offsetLngLat(pose.lng, pose.lat, velocity.eastMps * dtSec, velocity.northMps * dtSec);
  return { ...pose, lng, lat, altitudeM: pose.altitudeM + velocity.upMps * dtSec };
}
