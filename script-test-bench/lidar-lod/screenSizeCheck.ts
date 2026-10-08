import { screenSpaceSize } from '../../src/features/lidar/viewer/lod/frustum.ts';
import { mat4MultiplyInto } from '../../src/features/lidar/viewer/renderer/math.ts';
import type { AABB } from '../../src/features/lidar/viewer/lod/types.ts';
import { check } from './harness.ts';

// ---------------------------------------------------------------------------
// 2. Taille écran indépendante de l'inclinaison
// ---------------------------------------------------------------------------

/** Même calcul d'orbite que viewer/camera.ts. */
export function orbitViewMatrix(radius: number, theta: number, phi: number, target: [number, number, number] = [0, 0, 0]): {
  view: Float32Array;
  eye: [number, number, number];
} {
  const eye: [number, number, number] = [
    target[0] + radius * Math.sin(phi) * Math.sin(theta),
    target[1] + radius * Math.cos(phi),
    target[2] + radius * Math.sin(phi) * Math.cos(theta),
  ];
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  const fLen = Math.hypot(fx, fy, fz);
  fx /= fLen; fy /= fLen; fz /= fLen;
  let rx = -fz, ry = 0, rz = fx;
  const rLen = Math.hypot(rx, ry, rz) || 1;
  rx /= rLen; ry /= rLen; rz /= rLen;
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  const view = new Float32Array([
    rx, ux, -fx, 0,
    ry, uy, -fy, 0,
    rz, uz, -fz, 0,
    -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
    -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
    fx * eye[0] + fy * eye[1] + fz * eye[2],
    1,
  ]);
  return { view, eye };
}

/** Projection infinie en Z inversé, comme camera.getRenderProjMatrix(). */
export function renderProjection(aspect: number): Float32Array {
  const f = 1 / Math.tan(Math.PI / 8);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[11] = -1;
  m[14] = 0.05;
  return m;
}

export function runScreenSizeCheck(): void {
  const aabb: AABB = { minX: -25, maxX: 25, minY: -25, maxY: 25, minZ: -25, maxZ: 25 };
  const proj = renderProjection(1920 / 1080);
  const viewProj = new Float32Array(16);
  const pitches = [0.05, 0.3, Math.PI / 4, Math.PI / 3, 1.4];
  const fixed: number[] = [];
  const legacy: number[] = [];
  for (const phi of pitches) {
    mat4MultiplyInto(viewProj, proj, orbitViewMatrix(400, 0.7, phi).view);
    fixed.push(screenSpaceSize(aabb, viewProj, 1920, 1080, proj[5]!));
    legacy.push(screenSpaceSize(aabb, viewProj, 1920, 1080, viewProj[5]!));
  }
  const spread = (values: number[]) => Math.max(...values) / Math.max(1e-9, Math.min(...values));
  check(
    'Taille écran nœud selon l’inclinaison (φ 0,05 → 1,4 rad)',
    spread(fixed) < 1.01,
    `écart ×${spread(legacy).toFixed(1)} (vue de dessus : ${legacy[0]!.toFixed(1)} px au lieu de ${fixed[0]!.toFixed(1)})`,
    `écart ×${spread(fixed).toFixed(3)}`,
  );
}
