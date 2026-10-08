// ============================================
// Outils du viewer LiDAR — vue à 360° depuis un point (première personne)
// ============================================
//
// La caméra se place là où se tiendrait une personne : l'œil à 1,7 m au-dessus
// du sol réel au point (le plus haut retour sol autour des pieds, pas le modèle
// lissé dessous, pour qu'un sommet reste un sommet), et tourne autour sur 360°.
// Champs de vision :
//  - œil : ≈ 114°, le champ binoculaire humain (les deux yeux, avec la
//    profondeur). Le champ visuel entier (≈ 200° × 135°) ne peut pas être
//    dessiné dans une perspective plane sans étirer les bords à l'excès ;
//  - naturel : 60°, l'angle que couvre un écran à bout de bras : la perspective
//    à l'écran correspond à celle de l'œil, rien ne paraît étiré ;
//  - jumelles ×8 : ≈ 7,5°, le champ réel d'une 8×42.
// Le réticule lit ce qu'il vise sur le modèle de sol : distance, altitude et
// angle au-dessus ou au-dessous de l'horizon.

import type { CameraController } from '../../camera';
import { OBSERVER_HEIGHT_M } from '../terrain/viewshed';
import type { TerrainField } from '../terrain/terrainField';
import type { ScenePick, Vec3 } from '../types';

export type FovPresetId = 'eye' | 'natural' | 'binoculars';

export interface FovPreset {
  id: FovPresetId;
  /** Champ de vision horizontal, degrés. */
  fovDeg: number;
}

export const FOV_PRESETS: readonly FovPreset[] = [
  { id: 'eye', fovDeg: 114 },
  { id: 'natural', fovDeg: 60 },
  { id: 'binoculars', fovDeg: 7.5 },
];

const DEFAULT_FOV_PRESET: FovPresetId = 'eye';
/** On regarde légèrement vers le bas en marchant et en balayant le terrain. */
const INITIAL_PITCH_DEG = -5;
/** Rayon autour des pieds où l'on cherche le sol le plus haut, m. */
const FOOTPRINT_RADIUS_M = 0.75;
/** Classe sol ASPRS. */
const GROUND_CLASS = 2;

export interface LookAroundStart {
  eye: Vec3;
  yaw: number;
  pitch: number;
  fovX: number;
  /** Altitude du sol sous l'œil, m. */
  groundAltitudeM: number;
}

/** Où et comment la vue à la première personne démarre pour un point choisi. */
export function resolveLookAroundStart(field: TerrainField, camera: CameraController, pick: ScenePick): LookAroundStart | null {
  let ground = field.altitudeAt(pick.projX, pick.projY);
  if (ground == null) return null;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const z = field.altitudeAt(pick.projX + Math.cos(a) * FOOTPRINT_RADIUS_M, pick.projY + Math.sin(a) * FOOTPRINT_RADIUS_M);
    if (z != null) ground = Math.max(ground, z);
  }
  // Un retour sol choisi est la vraie surface (le modèle la moyenne).
  if (pick.source === 'points' && pick.classification === GROUND_CLASS) ground = Math.max(ground, pick.altitudeM);
  const eye = field.toLocal(pick.projX, pick.projY, ground + OBSERVER_HEIGHT_M);

  // Continuer à regarder dans la direction où la caméra regardait le point.
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

/** Caps essayés autour de celui de la caméra, et jusqu'où une vue dégagée compte (m). */
const HEADING_STEP_DEG = 15;
const HEADING_SPREAD_STEPS = 6;
const OPEN_VIEW_M = 20_000;

/**
 * Cap offrant la vue la plus lointaine près de celui de la caméra : debout dans
 * une pente, la direction de la caméra fait souvent face à la pente elle-même
 * (un mur à quelques mètres) ; la vue s'ouvre du côté le plus proche qui voit loin.
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
    // Pas d'impact au sol : la vue va jusqu'au bord des données chargées, pas au-delà.
    const reach = Math.min(OPEN_VIEW_M, hit?.distance ?? exitDistance(field, eye, dir));
    // Les vues lointaines l'emportent ; à égalité, rester près du cap de la caméra.
    const score = Math.log(reach) - 0.004 * Math.abs(k * HEADING_STEP_DEG);
    if (score > bestScore) {
      bestScore = score;
      best = yaw;
    }
  }
  return best;
}

/** Distance horizontale de l'œil au bord de la zone chargée selon `dir`, m. */
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
  /** Cap vrai de la vue, degrés dans le sens horaire depuis le nord. */
  headingDeg: number;
  /** Angle de vue au-dessus (+) ou au-dessous (−) de l'horizon, degrés. */
  pitchDeg: number;
  /** Champ de vision horizontal, degrés. */
  fovDeg: number;
  /** Sol visé par le réticule, `null` pour le ciel ou au-delà de la zone chargée. */
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
