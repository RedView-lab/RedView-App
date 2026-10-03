import {
  GUARD_EYE_CLEARANCE_M,
  GUARD_EYE_CLEARANCE_PER_DISTANCE,
  GUARD_SAMPLE_FRACTIONS,
  GUARD_SIGHT_MARGIN_M,
  GUARD_SIGHT_MARGIN_PER_DISTANCE,
  ORBIT_AMPLITUDE_DEG,
  ORBIT_EXTRA_DISTANCE_RATIO,
  ORBIT_PITCH_DEG,
  PITCH_MAX_DEG,
  PITCH_MIN_DEG,
  TARGET_LEAD_PER_DISTANCE,
} from '../config';
import type { CameraRail } from './cameraRail';
import { sampleAt } from './filters';
import { metersPerMercatorUnitAtY, toDegrees, toRadians } from './geo';
import { basePitchForDistance, cameraDistanceForSpeed } from './laws';

/** Pose FreeCamera : position de l'œil (Mercator + altitude) et orientation. */
export interface CameraPose {
  x: number;
  y: number;
  altitudeM: number;
  pitchDeg: number;
  bearingDeg: number;
}

/** Image calculée pour une position de lecture. */
export interface RailFrame {
  pose: CameraPose;
  targetX: number;
  targetY: number;
  targetAltitudeM: number;
  /** Distance œil → point visé avant relèvement (m), champ de vision compris. */
  distanceM: number;
  /** Recul horizontal et hauteur de l'œil par rapport au point visé, sans relèvement (m). */
  horizontalM: number;
  verticalM: number;
  /** Altitude de l'œil sans relèvement (m, exagérée). */
  baseEyeAltitudeM: number;
}

export function createCameraPose(): CameraPose {
  return { x: 0, y: 0, altitudeM: 0, pitchDeg: 0, bearingDeg: 0 };
}

export function createRailFrame(): RailFrame {
  return {
    pose: createCameraPose(),
    targetX: 0,
    targetY: 0,
    targetAltitudeM: 0,
    distanceM: 0,
    horizontalM: 0,
    verticalM: 0,
    baseEyeAltitudeM: 0,
  };
}

export interface RailFrameRequest {
  /** Position de la tête sur la trace (m). */
  distanceM: number;
  /** Multiplicateur de vitesse effectif (lissé). */
  speedMultiplier: number;
  /** Cap de la caméra (radians), hors orbite hélico. */
  headingRad: number;
  /** Phase de l'orbite hélico (radians) ; l'amplitude vient du rail. */
  orbitPhaseRad: number;
  /** Rapprochement lié au champ de vision (`fovDistanceFactor`). */
  fovDistanceFactor: number;
  /** Exagération du relief rendu. */
  exaggeration: number;
  /** Altitude à viser quand la trace n'en a pas (relief rendu, déjà exagéré). */
  fallbackTargetAltitudeM: number;
}

/**
 * Pose de la caméra à une position de lecture : le point visé est sur la
 * ligne lissée, un peu devant la tête (la tête tombe dans le tiers inférieur),
 * l'œil est placé derrière selon le cap à la distance liée à la vitesse. En
 * plan hélico il orbite lentement autour de la cible, un peu plus haut.
 * Pose sans relèvement : voir `liftCameraPose`.
 */
export function computeRailFrame(rail: CameraRail, request: RailFrameRequest, out: RailFrame): RailFrame {
  const { spacingM, lengthM } = rail;
  const index = Math.max(0, Math.min(lengthM, request.distanceM)) / spacingM;
  const speed = sampleAt(rail.speedMps, index) * request.speedMultiplier;
  const helico = sampleAt(rail.helicoWeight, index);
  // Distance de cadrage (champ Mapbox par défaut) : fixe ce qui est visible.
  const framingM = cameraDistanceForSpeed(speed) * (1 + ORBIT_EXTRA_DISTANCE_RATIO * helico);
  const distanceM = framingM * request.fovDistanceFactor;
  const targetIndex = Math.min(lengthM, request.distanceM + TARGET_LEAD_PER_DISTANCE * framingM) / spacingM;
  const targetX = sampleAt(rail.centerX, targetIndex);
  const targetY = sampleAt(rail.centerY, targetIndex);
  const targetAltitudeM = rail.hasElevation
    ? sampleAt(rail.elevationM, targetIndex) * request.exaggeration
    : request.fallbackTargetAltitudeM;

  const pitchDeg = Math.max(
    PITCH_MIN_DEG,
    Math.min(
      PITCH_MAX_DEG,
      basePitchForDistance(framingM) + sampleAt(rail.pitchReliefDeg, index) - ORBIT_PITCH_DEG * helico,
    ),
  );
  const pitch = toRadians(pitchDeg);
  const horizontalM = distanceM * Math.sin(pitch);
  const verticalM = distanceM * Math.cos(pitch);
  const unitsPerMeter = 1 / metersPerMercatorUnitAtY(targetY);
  const heading = request.headingRad + helico * toRadians(ORBIT_AMPLITUDE_DEG) * Math.sin(request.orbitPhaseRad);

  const pose = out.pose;
  // Derrière la cible selon le cap ; nord = −y en Mercator.
  pose.x = targetX - Math.sin(heading) * horizontalM * unitsPerMeter;
  pose.y = targetY + Math.cos(heading) * horizontalM * unitsPerMeter;
  out.baseEyeAltitudeM = targetAltitudeM + verticalM;
  pose.altitudeM = out.baseEyeAltitudeM;
  pose.pitchDeg = pitchDeg;
  pose.bearingDeg = toDegrees(heading);

  out.targetX = targetX;
  out.targetY = targetY;
  out.targetAltitudeM = targetAltitudeM;
  out.distanceM = distanceM;
  out.horizontalM = horizontalM;
  out.verticalM = verticalM;
  return out;
}

/**
 * Relève l'œil de `liftM` à la verticale : la cible ne bouge pas, l'orientation
 * est recalculée depuis le vecteur œil → cible (vue plus plongeante).
 */
export function liftCameraPose(frame: RailFrame, liftM: number): void {
  const lift = Math.max(0, liftM);
  frame.pose.altitudeM = frame.baseEyeAltitudeM + lift;
  frame.pose.pitchDeg = toDegrees(Math.atan2(frame.horizontalM, frame.verticalM + lift));
}

/** Altitude du relief rendu (exagéré) en un point Mercator, `null` si inconnue. */
export type GroundSampler = (x: number, y: number) => number | null;

/**
 * Relèvement de l'œil nécessaire pour (1) garder une marge au-dessus du sol
 * sous la caméra et (2) voir la tête par-dessus le relief (crête, épaulement
 * entre deux lacets). `eyeGroundFallbackM` sert quand le sol sous l'œil n'est
 * pas chargé (hors champ). Plafonné : une tête dans un tunnel ne doit pas
 * envoyer la caméra dans l'espace.
 */
export function requiredLift(
  frame: RailFrame,
  headX: number,
  headY: number,
  headAltitudeM: number,
  ground: GroundSampler,
  eyeGroundFallbackM: number,
): number {
  const { pose, distanceM, baseEyeAltitudeM } = frame;
  const eyeGround = ground(pose.x, pose.y) ?? eyeGroundFallbackM;
  let lift = eyeGround + GUARD_EYE_CLEARANCE_M + GUARD_EYE_CLEARANCE_PER_DISTANCE * distanceM - baseEyeAltitudeM;
  const headGround = ground(headX, headY);
  const head = headGround == null ? headAltitudeM : Math.max(headAltitudeM, headGround);
  const margin = GUARD_SIGHT_MARGIN_M + GUARD_SIGHT_MARGIN_PER_DISTANCE * distanceM;
  for (const f of GUARD_SAMPLE_FRACTIONS) {
    const g = ground(pose.x + (headX - pose.x) * f, pose.y + (headY - pose.y) * f);
    if (g == null) continue;
    const rayAltitude = baseEyeAltitudeM + (head - baseEyeAltitudeM) * f;
    const deficit = g + margin - rayAltitude;
    // Relever l'œil de Δ relève le rayon de (1 − f)·Δ à cette fraction.
    if (deficit > 0) lift = Math.max(lift, deficit / (1 - f));
  }
  return Math.max(0, Math.min(1.5 * distanceM, lift));
}
