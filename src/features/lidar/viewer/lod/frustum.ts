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

  // Near:   row3 + row2  (WebGPU: clip z in [0,1])
  planes[16] = vp[3]  + vp[2];
  planes[17] = vp[7]  + vp[6];
  planes[18] = vp[11] + vp[10];
  planes[19] = vp[15] + vp[14];

  // Far:    row3 - row2
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
 * Projects all 8 corners to NDC and measures the bounding rect extent.
 */
export function screenSpaceSize(
  aabb: AABB,
  viewProj: Float32Array,
  viewportW: number,
  viewportH: number,
): number {
  let minNdcX = Infinity, maxNdcX = -Infinity;
  let minNdcY = Infinity, maxNdcY = -Infinity;
  let anyBehind = false;

  const projectCorner = (x: number, y: number, z: number) => {
    const w = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];

    if (w <= 0.001) {
      anyBehind = true;
      return;
    }

    const invW = 1 / w;
    const ndcX = (viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12]) * invW;
    const ndcY = (viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13]) * invW;

    if (ndcX < minNdcX) minNdcX = ndcX;
    if (ndcX > maxNdcX) maxNdcX = ndcX;
    if (ndcY < minNdcY) minNdcY = ndcY;
    if (ndcY > maxNdcY) maxNdcY = ndcY;
  };

  projectCorner(aabb.minX, aabb.minY, aabb.minZ);
  projectCorner(aabb.maxX, aabb.minY, aabb.minZ);
  projectCorner(aabb.minX, aabb.maxY, aabb.minZ);
  projectCorner(aabb.maxX, aabb.maxY, aabb.minZ);
  projectCorner(aabb.minX, aabb.minY, aabb.maxZ);
  projectCorner(aabb.maxX, aabb.minY, aabb.maxZ);
  projectCorner(aabb.minX, aabb.maxY, aabb.maxZ);
  projectCorner(aabb.maxX, aabb.maxY, aabb.maxZ);

  if (anyBehind) {
    if (maxNdcX === -Infinity) return 0;
    return Math.max(viewportW, viewportH);
  }

  if (maxNdcX === -Infinity) return 0;

  const pixW = (maxNdcX - minNdcX) * 0.5 * viewportW;
  const pixH = (maxNdcY - minNdcY) * 0.5 * viewportH;

  return Math.max(pixW, pixH);
}
