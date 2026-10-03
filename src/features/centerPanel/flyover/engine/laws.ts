import {
  CAMERA_DISTANCE_MAX_M,
  CAMERA_DISTANCE_MIN_M,
  CAMERA_DISTANCE_REFERENCE_M,
  CAMERA_DISTANCE_REFERENCE_SPEED_MPS,
  CAMERA_DISTANCE_SPEED_EXPONENT,
  DURATION_MAX_S,
  DURATION_MIN_S,
  DURATION_REFERENCE_KM,
  DURATION_REFERENCE_S,
  HEADING_MAX_RATE_DEG_S,
  HEADING_TRACK_BLEND_RATE_RATIO,
  HEADING_TRACK_BLEND_S,
  MAPBOX_DEFAULT_FOV_DEG,
  PITCH_FAR_DEG,
  PITCH_FAR_DISTANCE_M,
  PITCH_NEAR_DEG,
  PITCH_NEAR_DISTANCE_M,
  RAIL_SPACING_MAX_M,
  RAIL_SPACING_MIN_M,
  RAIL_TARGET_SAMPLES,
} from '../config';
import { smoothstep } from './springs';

/** Durée de lecture à 1× : sous-linéaire en longueur (un 600 km ne dure pas 60× un 10 km). */
export function playbackDurationForLength(lengthM: number): number {
  const scaled = DURATION_REFERENCE_S * Math.sqrt(Math.max(0, lengthM) / 1000 / DURATION_REFERENCE_KM);
  return Math.max(DURATION_MIN_S, Math.min(DURATION_MAX_S, scaled));
}

/**
 * Distance œil → point visé pour une vitesse au sol de lecture : la caméra
 * prend de la hauteur quand elle va vite, le défilement à l'image reste
 * régulier (et les tuiles ont le temps d'arriver).
 */
export function cameraDistanceForSpeed(speedMps: number): number {
  const ratio = Math.max(0, speedMps) / CAMERA_DISTANCE_REFERENCE_SPEED_MPS;
  const distance = CAMERA_DISTANCE_REFERENCE_M * ratio ** CAMERA_DISTANCE_SPEED_EXPONENT;
  return Math.max(CAMERA_DISTANCE_MIN_M, Math.min(CAMERA_DISTANCE_MAX_M, distance));
}

/** Inclinaison de base : rasante de près, plus plongeante de loin (interpolation logarithmique). */
export function basePitchForDistance(distanceM: number): number {
  const t = Math.log(Math.max(1, distanceM) / PITCH_NEAR_DISTANCE_M) / Math.log(PITCH_FAR_DISTANCE_M / PITCH_NEAR_DISTANCE_M);
  return PITCH_NEAR_DEG + (PITCH_FAR_DEG - PITCH_NEAR_DEG) * smoothstep(t);
}

/** Pas du rail pour une longueur donnée. */
export function railSpacingForLength(lengthM: number): number {
  return Math.max(RAIL_SPACING_MIN_M, Math.min(RAIL_SPACING_MAX_M, lengthM / RAIL_TARGET_SAMPLES));
}

/**
 * Durée du fondu de cap lors d'un changement de palier : l'écart s'efface en
 * smootherstep, dont la pente max vaut 1,875 × écart / durée ; on la garde sous
 * HEADING_TRACK_BLEND_RATE_RATIO × la rotation max.
 */
export function headingBlendDurationS(offsetRad: number): number {
  const maxBlendRate = HEADING_TRACK_BLEND_RATE_RATIO * ((HEADING_MAX_RATE_DEG_S * Math.PI) / 180);
  return Math.max(HEADING_TRACK_BLEND_S, (1.875 * Math.abs(offsetRad)) / maxBlendRate);
}

/**
 * Rapprochement de la caméra pour un champ `fovDeg` : la largeur visible au
 * point visé reste celle du champ Mapbox par défaut (même cadrage, même
 * niveau de détail), seule la perspective change.
 */
export function fovDistanceFactor(fovDeg: number): number {
  const half = (deg: number) => Math.tan((deg * Math.PI) / 360);
  return half(MAPBOX_DEFAULT_FOV_DEG) / half(Math.max(1, Math.min(60, fovDeg)));
}
