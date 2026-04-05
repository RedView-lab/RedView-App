import type { AABB } from './types';

export type CullResult = 'outside' | 'intersect' | 'inside';

/** 6 frustum planes extracted from view-projection matrix (column-major) */
export type FrustumPlanes = Float32Array; // 24 floats: 6 planes × (nx, ny, nz, d)

export function extractFrustumPlanes(vp: Float32Array): FrustumPlanes {
  const planes = new Float32Array(24);
  // Left
  planes[0] = vp[3] + vp[0]; planes[1] = vp[7] + vp[4]; planes[2] = vp[11] + vp[8]; planes[3] = vp[15] + vp[12];
  // Right
  planes[4] = vp[3] - vp[0]; planes[5] = vp[7] - vp[4]; planes[6] = vp[11] - vp[8]; planes[7] = vp[15] - vp[12];
  // Bottom
  planes[8] = vp[3] + vp[1]; planes[9] = vp[7] + vp[5]; planes[10] = vp[11] + vp[9]; planes[11] = vp[15] + vp[13];
  // Top
  planes[12] = vp[3] - vp[1]; planes[13] = vp[7] - vp[5]; planes[14] = vp[11] - vp[9]; planes[15] = vp[15] - vp[13];
  // Near
  planes[16] = vp[3] + vp[2]; planes[17] = vp[7] + vp[6]; planes[18] = vp[11] + vp[10]; planes[19] = vp[15] + vp[14];
  // Far
  planes[20] = vp[3] - vp[2]; planes[21] = vp[7] - vp[6]; planes[22] = vp[11] - vp[10]; planes[23] = vp[15] - vp[14];

  // Normalize each plane
  for (let i = 0; i < 6; i++) {
    const b = i * 4;
    const len = Math.sqrt(planes[b] ** 2 + planes[b + 1] ** 2 + planes[b + 2] ** 2);
    if (len > 0) {
      planes[b] /= len; planes[b + 1] /= len; planes[b + 2] /= len; planes[b + 3] /= len;
    }
  }
  return planes;
}

export function testAABB(planes: FrustumPlanes, aabb: AABB): CullResult {
  let allInside = true;
  for (let i = 0; i < 6; i++) {
    const b = i * 4;
    const nx = planes[b], ny = planes[b + 1], nz = planes[b + 2], d = planes[b + 3];

    // P vertex (most positive along plane normal)
    const px = nx >= 0 ? aabb.maxX : aabb.minX;
    const py = ny >= 0 ? aabb.maxY : aabb.minY;
    const pz = nz >= 0 ? aabb.maxZ : aabb.minZ;

    if (nx * px + ny * py + nz * pz + d < 0) return 'outside';

    // N vertex (most negative along plane normal)
    const nmx = nx >= 0 ? aabb.minX : aabb.maxX;
    const nmy = ny >= 0 ? aabb.minY : aabb.maxY;
    const nmz = nz >= 0 ? aabb.minZ : aabb.maxZ;

    if (nx * nmx + ny * nmy + nz * nmz + d < 0) allInside = false;
  }
  return allInside ? 'inside' : 'intersect';
}

/**
 * Compute screen-space extent of an AABB in pixels.
 * Projects all 8 corners to NDC, returns max extent in pixels.
 */
export function screenSpaceSize(
  aabb: AABB,
  viewProj: Float32Array,
  viewportW: number,
  viewportH: number,
): number {
  let minNdcX = Infinity, maxNdcX = -Infinity;
  let minNdcY = Infinity, maxNdcY = -Infinity;
  let anyInFront = false;

  const corners = [
    aabb.minX, aabb.minY, aabb.minZ,
    aabb.maxX, aabb.minY, aabb.minZ,
    aabb.minX, aabb.maxY, aabb.minZ,
    aabb.maxX, aabb.maxY, aabb.minZ,
    aabb.minX, aabb.minY, aabb.maxZ,
    aabb.maxX, aabb.minY, aabb.maxZ,
    aabb.minX, aabb.maxY, aabb.maxZ,
    aabb.maxX, aabb.maxY, aabb.maxZ,
  ];

  for (let i = 0; i < 24; i += 3) {
    const x = corners[i], y = corners[i + 1], z = corners[i + 2];
    const w = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (w <= 0) continue; // behind camera
    anyInFront = true;
    const invW = 1 / w;
    const ndcX = (viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12]) * invW;
    const ndcY = (viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13]) * invW;
    if (ndcX < minNdcX) minNdcX = ndcX;
    if (ndcX > maxNdcX) maxNdcX = ndcX;
    if (ndcY < minNdcY) minNdcY = ndcY;
    if (ndcY > maxNdcY) maxNdcY = ndcY;
  }

  if (!anyInFront) return 0;

  // If some corners are behind camera, the node straddles the near plane → large
  if (minNdcX === Infinity) return Math.max(viewportW, viewportH);

  const extentX = (maxNdcX - minNdcX) * 0.5 * viewportW;
  const extentY = (maxNdcY - minNdcY) * 0.5 * viewportH;
  return Math.max(extentX, extentY);
}
