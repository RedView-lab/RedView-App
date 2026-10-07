// ============================================
// LiDAR viewer tools — 360° view from a point (first person)
// ============================================
//
// The camera stands where a person would: eye 1.7 m above the real ground
// at the point (the highest ground return around the feet, not the
// smoothed model under them, so a summit stays a summit), and turns around
// it over 360°. Fields of view:
//  - eye: ≈ 114°, the human binocular field (both eyes, with depth). The
//    whole visual field (≈ 200° × 135°) cannot be drawn in a flat
//    perspective without stretching the edges beyond use;
//  - natural: 60°, the angle a screen covers at arm's length: the
//    perspective on screen matches the eye's, nothing looks stretched;
//  - binoculars ×8: ≈ 7.5° real field of an 8×42.
// The reticle reads what it aims at on the ground model: distance,
// altitude and the angle above or below the horizon.

import type { CameraController } from '../../camera';
import { OBSERVER_HEIGHT_M } from '../terrain/viewshed';
import type { TerrainField } from '../terrain/terrainField';
import type { ScenePick, Vec3 } from '../types';

export type FovPresetId = 'eye' | 'natural' | 'binoculars';

export interface FovPreset {
  id: FovPresetId;
  /** Horizontal field of view, degrees. */
  fovDeg: number;
}

export const FOV_PRESETS: readonly FovPreset[] = [
  { id: 'eye', fovDeg: 114 },
  { id: 'natural', fovDeg: 60 },
  { id: 'binoculars', fovDeg: 7.5 },
];

const DEFAULT_FOV_PRESET: FovPresetId = 'eye';
/** People look slightly down when they walk and scan terrain. */
const INITIAL_PITCH_DEG = -5;
/** Radius around the feet searched for the highest ground, m. */
const FOOTPRINT_RADIUS_M = 0.75;
/** ASPRS ground class. */
const GROUND_CLASS = 2;

export interface LookAroundStart {
  eye: Vec3;
  yaw: number;
  pitch: number;
  fovX: number;
  /** Ground altitude under the eye, m. */
  groundAltitudeM: number;
}

/** Where and how the first-person view starts for a picked point. */
export function resolveLookAroundStart(field: TerrainField, camera: CameraController, pick: ScenePick): LookAroundStart | null {
  let ground = field.altitudeAt(pick.projX, pick.projY);
  if (ground == null) return null;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const z = field.altitudeAt(pick.projX + Math.cos(a) * FOOTPRINT_RADIUS_M, pick.projY + Math.sin(a) * FOOTPRINT_RADIUS_M);
    if (z != null) ground = Math.max(ground, z);
  }
  // A picked ground return is the real surface (the model averages it).
  if (pick.source === 'points' && pick.classification === GROUND_CLASS) ground = Math.max(ground, pick.altitudeM);
  const eye = field.toLocal(pick.projX, pick.projY, ground + OBSERVER_HEIGHT_M);

  // Keep looking the way the camera looked at the point.
  const from = camera.getEye();
  let hx = eye[0] - from[0];
  let hz = eye[2] - from[2];
  if (Math.hypot(hx, hz) < 1) {
    const forward = camera.getForward();
    hx = forward[0];
    hz = forward[2];
  }
  const cameraYaw = Math.hypot(hx, hz) > 1e-6 ? Math.atan2(hx, -hz) : 0;
  const preset = FOV_PRESETS.find((p) => p.id === DEFAULT_FOV_PRESET)!;
  return {
    eye,
    yaw: openestHeading(field, eye, cameraYaw),

    pitch: (INITIAL_PITCH_DEG * Math.PI) / 180,
    fovX: (preset.fovDeg * Math.PI) / 180,
    groundAltitudeM: ground,
  };
}

/** Headings tried around the camera's, and how far a clear view counts (m). */
const HEADING_STEP_DEG = 15;
const HEADING_SPREAD_STEPS = 6;
const OPEN_VIEW_M = 20_000;

/**
 * Heading with the farthest view near the camera's own: standing on a
 * slope, the camera's direction often faces the slope itself (a wall a
 * few metres away); the view opens the nearest way to it that sees far.
 */
function openestHeading(field: TerrainField, eye: Vec3, cameraYaw: number): number {
  let best = cameraYaw;
  let bestScore = -Infinity;
  const pitch = (-2 * Math.PI) / 180;
  for (let k = -HEADING_SPREAD_STEPS; k <= HEADING_SPREAD_STEPS; k++) {
    const yaw = cameraYaw + (k * HEADING_STEP_DEG * Math.PI) / 180;
    const c = Math.cos(pitch);
    const dir: Vec3 = [Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
    const hit = field.raycast(eye, dir);
    // No ground hit: the view runs to the edge of the loaded data, not beyond.
    const reach = Math.min(OPEN_VIEW_M, hit?.distance ?? exitDistance(field, eye, dir));
    // Far views win; ties stay close to the camera's heading.
    const score = Math.log(reach) - 0.004 * Math.abs(k * HEADING_STEP_DEG);
    if (score > bestScore) {
      bestScore = score;
      best = yaw;
    }
  }
  return best;
}

/** Horizontal distance from the eye to the edge of the loaded area along `dir`, m. */
function exitDistance(field: TerrainField, eye: Vec3, dir: Vec3): number {
  const x = eye[0] + field.centerX;
  const y = field.centerY - eye[2];
  const dx = dir[0];
  const dy = -dir[2];
  const tx = dx > 1e-9 ? (field.maxX - x) / dx : dx < -1e-9 ? (field.minX - x) / dx : Infinity;
  const ty = dy > 1e-9 ? (field.maxY - y) / dy : dy < -1e-9 ? (field.minY - y) / dy : Infinity;
  return Math.max(1, Math.min(tx, ty, OPEN_VIEW_M));
}

export interface LookAroundReadout {
  /** True heading of the view, degrees clockwise from north. */
  headingDeg: number;
  /** View angle above (+) or below (−) the horizon, degrees. */
  pitchDeg: number;
  /** Horizontal field of view, degrees. */
  fovDeg: number;
  /** Ground aimed at by the reticle, `null` for the sky or beyond the loaded area. */
  target: { distanceM: number; altitudeM: number; elevationDeg: number } | null;
}

export function readLookAround(field: TerrainField, camera: CameraController): LookAroundReadout {
  const pose = camera.getLookPose();
  const eye: Vec3 = [pose.eyeX, pose.eyeY, pose.eyeZ];
  const forward = camera.getForward();
  const hit = field.raycast(eye, forward);
  let target: LookAroundReadout['target'] = null;
  if (hit) {
    const run = Math.hypot(hit.local[0] - eye[0], hit.local[2] - eye[2]);
    const rise = hit.local[1] - eye[1];
    target = {
      distanceM: Math.hypot(run, rise),
      altitudeM: hit.local[1] + field.centerZ,
      elevationDeg: (Math.atan2(rise, run) * 180) / Math.PI,
    };
  }
  return {
    headingDeg: field.gridToTrueAzimuth((pose.yaw * 180) / Math.PI),
    pitchDeg: (pose.pitch * 180) / Math.PI,
    fovDeg: (pose.fovX * 180) / Math.PI,
    target,
  };
}
