// ============================================
// Directional light frames for the photo mode's shadow maps
// ============================================
//
// Orthographic view-projections looking from the sun (WebGPU clip space:
// x, y in [−1, 1], depth 0 nearest the sun, 1 farthest). Cascade 0 frames
// the whole scene; cascade 1 a square around what the camera looks at,
// snapped to its texel grid so a small camera move never makes the shadow
// edges crawl.

import type { AABB } from '../../lod/types';

export type Vec3 = [number, number, number];

export interface LightFrame {
  right: Vec3;
  up: Vec3;
  /** Unit vector towards the light (the frame's +z). */
  toLight: Vec3;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

/** Right-handed basis (right, up, toLight), like a camera looking down −toLight. */
export function lightFrame(toLight: Vec3): LightFrame {
  const z = normalize(toLight);
  const ref: Vec3 = Math.abs(z[1]) < 0.995 ? [0, 1, 0] : [0, 0, -1];
  const right = normalize(cross(ref, z));
  const up = cross(z, right);
  return { right, up, toLight: z };
}

export interface LightProjection {
  /** Column-major view-projection. */
  matrix: Float32Array;
  /** Largest world size of one texel (m). */
  texelM: number;
  /** World distance covered by the depth range (m): depth × this = metres along the light. */
  depthRangeM: number;
}

function boxCorners(box: AABB): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push([i & 1 ? box.maxX : box.minX, i & 2 ? box.maxY : box.minY, i & 4 ? box.maxZ : box.minZ]);
  }
  return out;
}

function depthRange(frame: LightFrame, box: AABB, marginM: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const corner of boxCorners(box)) {
    const d = dot(corner, frame.toLight);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min - marginM, max + marginM];
}

function buildMatrix(
  frame: LightFrame,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  out: Float32Array,
): void {
  const sx = 2 / (x1 - x0);
  const sy = 2 / (y1 - y0);
  const sz = 1 / (z1 - z0);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const { right: r, up: u, toLight: l } = frame;
  out[0] = r[0] * sx; out[1] = u[0] * sy; out[2] = -l[0] * sz; out[3] = 0;
  out[4] = r[1] * sx; out[5] = u[1] * sy; out[6] = -l[1] * sz; out[7] = 0;
  out[8] = r[2] * sx; out[9] = u[2] * sy; out[10] = -l[2] * sz; out[11] = 0;
  out[12] = -cx * sx; out[13] = -cy * sy; out[14] = z1 * sz; out[15] = 1;
}

/** Projection framing the whole box (cascade 0). */
export function fitLightToBox(
  toLight: Vec3,
  box: AABB,
  resolution: number,
  out: Float32Array = new Float32Array(16),
): LightProjection {
  const frame = lightFrame(toLight);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const corner of boxCorners(box)) {
    const x = dot(corner, frame.right);
    const y = dot(corner, frame.up);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const [z0, z1] = depthRange(frame, box, 2);
  buildMatrix(frame, x0, x1, y0, y1, z0, z1, out);
  return { matrix: out, texelM: Math.max(x1 - x0, y1 - y0) / resolution, depthRangeM: z1 - z0 };
}

/**
 * Projection of a square of side 2·`halfSizeM` (in the light's view) around
 * `centre`, its depth covering the whole box so every caster above is kept;
 * the centre snaps to the texel grid.
 */
export function fitLightToSquare(
  toLight: Vec3,
  centre: ArrayLike<number>,
  halfSizeM: number,
  box: AABB,
  resolution: number,
  out: Float32Array = new Float32Array(16),
): LightProjection {
  const frame = lightFrame(toLight);
  const texel = (2 * halfSizeM) / resolution;
  const cx = Math.round(dot(centre, frame.right) / texel) * texel;
  const cy = Math.round(dot(centre, frame.up) / texel) * texel;
  const [z0, z1] = depthRange(frame, box, 2);
  buildMatrix(frame, cx - halfSizeM, cx + halfSizeM, cy - halfSizeM, cy + halfSizeM, z0, z1, out);
  return { matrix: out, texelM: texel, depthRangeM: z1 - z0 };
}

/** Clip-space position of a world point (x, y, depth). */
export function projectOrtho(matrix: Float32Array, p: ArrayLike<number>): Vec3 {
  return [
    matrix[0]! * p[0]! + matrix[4]! * p[1]! + matrix[8]! * p[2]! + matrix[12]!,
    matrix[1]! * p[0]! + matrix[5]! * p[1]! + matrix[9]! * p[2]! + matrix[13]!,
    matrix[2]! * p[0]! + matrix[6]! * p[1]! + matrix[10]! * p[2]! + matrix[14]!,
  ];
}
