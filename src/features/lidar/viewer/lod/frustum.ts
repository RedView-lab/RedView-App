// ============================================
// Octree LOD — Frustum Culling & Screen-Space Metrics
// ============================================

import type { AABB } from './types';

/** 6 frustum planes: [a,b,c,d] for ax+by+cz+d >= 0 (inside) */
export type FrustumPlanes = Float64Array; // 24 floats (6 × 4)

export const OUTSIDE = 0;
export const INTERSECT = 1;
export const INSIDE = 2;

const _planesBuffer = new Float64Array(24);

/**
 * Extract 6 frustum planes from a column-major viewProj matrix.
 * Planes point inward (positive half-space is inside the frustum).
 */
export function extractFrustumPlanes(vp: Float32Array): FrustumPlanes {
  const planes = _planesBuffer;

  // Left:   row3 + row0
  planes[0]  = vp[3]  + vp[0];
  planes[1]  = vp[7]  + vp[4];
  planes[2]  = vp[11] + vp[8];
  planes[3]  = vp[15] + vp[12];

  // Right:  row3 - row0
  planes[4]  = vp[3]  - vp[0];
  planes[5]  = vp[7]  - vp[4];
  planes[6]  = vp[11] - vp[8];
  planes[7]  = vp[15] - vp[12];

  // Bottom: row3 + row1
  planes[8]  = vp[3]  + vp[1];
  planes[9]  = vp[7]  + vp[5];
  planes[10] = vp[11] + vp[9];
  planes[11] = vp[15] + vp[13];

  // Top:    row3 - row1
  planes[12] = vp[3]  - vp[1];
  planes[13] = vp[7]  - vp[5];
  planes[14] = vp[11] - vp[9];
  planes[15] = vp[15] - vp[13];

  // Near:   row2 (WebGPU: clip z in [0,1], 0 <= z_clip)
  planes[16] = vp[2];
  planes[17] = vp[6];
  planes[18] = vp[10];
  planes[19] = vp[14];

  // Far:    row3 - row2 (z_clip <= w_clip)
  planes[20] = vp[3]  - vp[2];
  planes[21] = vp[7]  - vp[6];
  planes[22] = vp[11] - vp[10];
  planes[23] = vp[15] - vp[14];

  // Normalize each plane
  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    const len = Math.sqrt(planes[o] * planes[o] + planes[o + 1] * planes[o + 1] + planes[o + 2] * planes[o + 2]);
    if (len > 0) {
      const inv = 1 / len;
      planes[o] *= inv;
      planes[o + 1] *= inv;
      planes[o + 2] *= inv;
      planes[o + 3] *= inv;
    }
  }

  return planes;
}

/**
 * Test AABB against frustum planes.
 * Returns OUTSIDE, INTERSECT, or INSIDE.
 */
export function frustumTestAABB(planes: FrustumPlanes, aabb: AABB): number {
  let allInside = true;

  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    const a = planes[o], b = planes[o + 1], c = planes[o + 2], d = planes[o + 3];

    const px = a >= 0 ? aabb.maxX : aabb.minX;
    const py = b >= 0 ? aabb.maxY : aabb.minY;
    const pz = c >= 0 ? aabb.maxZ : aabb.minZ;

    const nx = a >= 0 ? aabb.minX : aabb.maxX;
    const ny = b >= 0 ? aabb.minY : aabb.maxY;
    const nz = c >= 0 ? aabb.minZ : aabb.maxZ;

    if (a * px + b * py + c * pz + d < 0) return OUTSIDE;
    if (a * nx + b * ny + c * nz + d < 0) allInside = false;
  }

  return allInside ? INSIDE : INTERSECT;
}

/**
 * Compute screen-space size of an AABB in pixels.
 * Uses bounding sphere projection in clip space: zero GC allocations, ultra-fast scalar math.
 */
export function screenSpaceSize(
  aabb: AABB,
  viewProj: Float32Array,
  viewportW: number,
  viewportH: number,
): number {
  const halfX = (aabb.maxX - aabb.minX) * 0.5;
  const halfY = (aabb.maxY - aabb.minY) * 0.5;
  const halfZ = (aabb.maxZ - aabb.minZ) * 0.5;
  const cx = aabb.minX + halfX;
  const cy = aabb.minY + halfY;
  const cz = aabb.minZ + halfZ;
  const radius = Math.sqrt(halfX * halfX + halfY * halfY + halfZ * halfZ);

  // Transform center into clip space (w is distance along camera forward in view space)
  const w = viewProj[3] * cx + viewProj[7] * cy + viewProj[11] * cz + viewProj[15];

  if (w <= radius) {
    // Camera is inside or very close to bounding volume
    return Math.max(viewportW, viewportH);
  }

  // viewProj[5] corresponds to proj[1][1] = 1 / tan(fov / 2)
  const projFactor = Math.abs(viewProj[5]) * (viewportH * 0.5);
  const pixelDiameter = (2 * radius * projFactor) / w;

  return Math.max(0, pixelDiameter);
}

