import type { CameraController } from '../camera';
import type { TerrainField } from './terrain/terrainField';
import type { ScenePick } from './types';

/** Baseline of the slope faced by "Face à la pente": the face, not a step in it (m). */
const FACE_SLOPE_BASELINE_M = 20;
/** Below this slope "Face à la pente" looks straight down. */
const FACE_SLOPE_MIN_DEG = 3;

/** Turns the orbit around the picked point, keeping the distance within reason. */
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
 * Looks at the slope along its normal: a face seen from below looks
 * steeper, from above flatter; seen square it shows its true shape.
 */
export function faceSlope(camera: CameraController, field: TerrainField, pick: ScenePick): void {
  const slope = field.slopeAt(pick.projX, pick.projY, FACE_SLOPE_BASELINE_M)
    ?? field.slopeAt(pick.projX, pick.projY);
  if (!slope) return;
  const ground = field.toLocal(pick.projX, pick.projY, pick.groundAltitudeM ?? pick.altitudeM);
  // Ground normal (−∂z/∂x, −∂z/∂y, 1) in the render frame (x east, y up, z = −north).
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
