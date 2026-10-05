import type { FreeCamAxes, FreeCamLookDelta, FreeCamPose } from '../types';
import { FREECAM_MAX_VIEW_PITCH, FREECAM_MIN_PITCH } from './config';

const METERS_PER_DEGREE_LAT = 111_320;
const DEG_TO_RAD = Math.PI / 180;
const MAX_ABS_LAT = 85;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeBearing(bearing: number): number {
  return ((bearing % 360) + 360) % 360;
}

function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Vitesse proportionnelle à la hauteur au-dessus du sol : précis près du terrain, rapide en altitude. */
export function speedForHeight(heightAboveGroundM: number, factor: number, minMps: number, maxMps: number): number {
  return clamp(Math.max(0, heightAboveGroundM) * factor, minMps, maxMps);
}

/** Décale un point de `eastM` / `northM` mètres (approximation locale, suffisante à l'échelle d'une frame). */
export function offsetLngLat(lng: number, lat: number, eastM: number, northM: number): [number, number] {
  const metersPerDegLng = METERS_PER_DEGREE_LAT * Math.max(0.01, Math.cos(lat * DEG_TO_RAD));
  return [
    wrapLng(lng + eastM / metersPerDegLng),
    clamp(lat + northM / METERS_PER_DEGREE_LAT, -MAX_ABS_LAT, MAX_ABS_LAT),
  ];
}

/**
 * Déplacement horizontal (est, nord) en mètres pour une frame. Le mouvement
 * reste dans le plan horizontal et ne suit que le bearing (vol « créatif »).
 */
export function horizontalDisplacementM(
  bearingDeg: number,
  axes: FreeCamAxes,
  speedMps: number,
  dtSec: number,
): { eastM: number; northM: number } {
  const length = Math.hypot(axes.forward, axes.strafe);
  if (length === 0) return { eastM: 0, northM: 0 };

  const forward = axes.forward / length;
  const strafe = axes.strafe / length;
  const bearingRad = bearingDeg * DEG_TO_RAD;
  const distance = speedMps * dtSec;

  return {
    eastM: (forward * Math.sin(bearingRad) + strafe * Math.cos(bearingRad)) * distance,
    northM: (forward * Math.cos(bearingRad) - strafe * Math.sin(bearingRad)) * distance,
  };
}

/** Souris vers la droite = tourner à droite ; souris vers le haut = regarder vers l'horizon. */
export function applyLook(pose: FreeCamPose, delta: FreeCamLookDelta, sensitivityDegPerPx: number): FreeCamPose {
  if (delta.dx === 0 && delta.dy === 0) return pose;
  return {
    ...pose,
    bearing: normalizeBearing(pose.bearing + delta.dx * sensitivityDegPerPx),
    pitch: clampPitch(pose.pitch - delta.dy * sensitivityDegPerPx),
  };
}

/** Pitch de regard : 0 = sol à la verticale, 90 = horizon, au-delà = ciel (via décalage optique). */
export function clampPitch(pitch: number): number {
  return clamp(pitch, FREECAM_MIN_PITCH, FREECAM_MAX_VIEW_PITCH);
}
