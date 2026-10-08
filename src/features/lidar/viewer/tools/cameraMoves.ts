import type { CameraController } from '../camera';
import type { TerrainField } from './terrain/terrainField';
import type { ScenePick } from './types';

/** Base de la pente visée par « Face à la pente » : le versant, pas une marche dedans (m). */
const FACE_SLOPE_BASELINE_M = 20;
/** Sous cette pente, « Face à la pente » regarde droit vers le bas. */
const FACE_SLOPE_MIN_DEG = 3;

/** Tourne l'orbite autour du point choisi, en gardant une distance raisonnable. */
export function centerOnPick(camera: CameraController, pick: ScenePick): void {
  const eye = camera.getEye();
  const distance = Math.hypot(eye[0] - pick.local[0], eye[1] - pick.local[1], eye[2] - pick.local[2]);
  camera.animateTo({
    targetX: pick.local[0],
    targetY: pick.local[1],
    targetZ: pick.local[2],
    radius: Math.max(30, Math.min(distance, camera.sceneRadius * 2)),
  });
}

/**
 * Regarde la pente selon sa normale : un versant vu d'en bas paraît plus raide,
 * d'en haut plus doux ; vu de face, il montre sa vraie forme.
 */
export function faceSlope(camera: CameraController, field: TerrainField, pick: ScenePick): void {
  const slope = field.slopeAt(pick.projX, pick.projY, FACE_SLOPE_BASELINE_M)
    ?? field.slopeAt(pick.projX, pick.projY);
  if (!slope) return;
  const ground = field.toLocal(pick.projX, pick.projY, pick.groundAltitudeM ?? pick.altitudeM);
  // Normale du sol (−∂z/∂x, −∂z/∂y, 1) dans le repère de rendu (x est, y haut, z = −nord).
  const nx = -slope.gradX;
  const ny = 1;
  const nz = slope.gradY;
  const length = Math.hypot(nx, ny, nz);
  const flat = slope.slopeDeg < FACE_SLOPE_MIN_DEG;
  const eye = camera.getEye();
  const distance = Math.hypot(eye[0] - ground[0], eye[1] - ground[1], eye[2] - ground[2]);
  camera.animateTo({
    targetX: ground[0],
    targetY: ground[1],
    targetZ: ground[2],
    phi: flat ? 0.15 : Math.acos(ny / length),
    theta: flat ? undefined : Math.atan2(nx / length, nz / length),
    radius: Math.max(120, Math.min(500, distance)),
  });
}
